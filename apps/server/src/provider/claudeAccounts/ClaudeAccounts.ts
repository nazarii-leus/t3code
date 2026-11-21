import {
  ProviderAccountsError,
  type ProviderAccount,
  type ProviderAccountSwitchEntry,
  type ProviderAccountsSnapshot,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ProviderAccountsController } from "@t3tools/provider-core/server/driver";

import {
  ClaudeAccountStoreError,
  describeLogin,
  makeClaudeAccountStore,
  type ClaudeAccountStore,
  type ClaudeLocks,
} from "./ClaudeAccountStore.ts";

/** Claude versions whose lock files and login keys step 1 measured (2.1.328), and later 2.1 patches. */
const claudeVersionSupportsSwitching = (version: string | null | undefined): boolean => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version?.trim() ?? "");
  return match !== null && match[1] === "2" && match[2] === "1" && Number(match[3]) >= 328;
};

const INACTIVE_PROBE_TTL_MS = 15 * 60_000;
const PROBE_BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 900_000];
const MAX_PARALLEL_PROBES = 2;
const AUTO_SWITCH_CAP_PER_HOUR = 5;
const HOUR_MS = 3_600_000;
const HISTORY_LIMIT = 20;

const JsonValue = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownEffect(JsonValue);
const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
let scratchCount = 0;

interface IndexEntry {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly organizationUuid: string | null;
  readonly organizationName: string | null;
  readonly organizationKind: ProviderAccount["organizationKind"];
  readonly plan: string | null;
  readonly autoSwitch: boolean;
  readonly addedAt: string;
}

interface StoreIndex {
  readonly version: 1;
  readonly accounts: ReadonlyArray<IndexEntry>;
  readonly history: ReadonlyArray<ProviderAccountSwitchEntry>;
  readonly autoSwitchLog: ReadonlyArray<string>;
  readonly pausedUntil: string | null;
  /** accountId -> windowId -> resetAt */
  readonly limitedUntil: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const EMPTY_INDEX: StoreIndex = {
  version: 1,
  accounts: [],
  history: [],
  autoSwitchLog: [],
  pausedUntil: null,
  limitedUntil: {},
};

interface ProbeState {
  readonly usageLimits: ServerProviderUsageLimits | null;
  readonly usageCheckedAt: string | null;
  readonly usageError: string | null;
  readonly models: ReadonlyArray<string> | null;
  readonly state: ProviderAccount["state"];
  readonly stateMessage: string | null;
  readonly nextProbeAt: number;
  readonly failures: number;
  readonly probing: boolean;
}

const EMPTY_PROBE: ProbeState = {
  usageLimits: null,
  usageCheckedAt: null,
  usageError: null,
  models: null,
  state: "ready",
  stateMessage: null,
  nextProbeAt: 0,
  failures: 0,
  probing: false,
};

export interface StoredAccountProbe {
  readonly models: ReadonlyArray<string> | undefined;
  readonly usageLimits: ServerProviderUsageLimits | undefined;
}

export type SwitchInitiator = ProviderAccountSwitchEntry["initiator"];

const claudePlanLabel = (
  subscriptionType: string | undefined,
  rateLimitTier: string | undefined,
): string | null => {
  const tier = rateLimitTier?.toLowerCase() ?? "";
  const kind = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "") ?? "";
  const base = kind.includes("team")
    ? "Team"
    : kind.includes("enterprise")
      ? "Enterprise"
      : kind.includes("pro")
        ? "Pro"
        : kind.includes("max")
          ? "Max"
          : kind
            ? kind[0]!.toUpperCase() + kind.slice(1)
            : null;
  const size = tier.includes("20x") ? "20x" : tier.includes("5x") ? "5x" : null;
  if (!base) return null;
  if (!size) return base;
  return base === "Max" ? `Max ${size}` : `${base} Max ${size}`;
};

const organizationKindOf = (type: unknown): ProviderAccount["organizationKind"] => {
  const value = typeof type === "string" ? type.toLowerCase() : "";
  if (value.includes("enterprise")) return "enterprise";
  if (value.includes("team")) return "team";
  return value ? "personal" : null;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

const exhaustedWindow = (limits: ServerProviderUsageLimits | null | undefined, now: number) =>
  (limits?.windows ?? []).find(
    (window) =>
      window.usedPercent >= 100 &&
      (window.resetsAt === undefined || Date.parse(window.resetsAt) > now),
  );

/** The candidate of the automatic switch (plan 5.7): room for every model in use, soonest weekly reset first. */
export const pickAccountSwitchTarget = (input: {
  readonly accounts: ReadonlyArray<ProviderAccount>;
  readonly limitedUntil: StoreIndex["limitedUntil"];
  readonly now: number;
  readonly modelsInUse: ReadonlyArray<string>;
  readonly windowId: string | null;
}): ProviderAccount | undefined => {
  const weeklyReset = (account: ProviderAccount) =>
    (account.usageLimits?.windows ?? [])
      .filter((window) => window.kind === "weekly" && window.modelIds === undefined)
      .map((window) => (window.resetsAt ? Date.parse(window.resetsAt) : Number.POSITIVE_INFINITY))
      .at(0) ?? Number.POSITIVE_INFINITY;
  const room = (account: ProviderAccount) => {
    const windows = account.usageLimits?.windows ?? [];
    const window = windows.find((candidate) => candidate.id === input.windowId) ?? windows[0];
    return window ? 100 - window.usedPercent : 0;
  };
  return input.accounts
    .filter((account) => {
      if (account.active || !account.autoSwitch || account.state !== "ready") return false;
      if (!account.usageLimits || account.usageLimits.windows.length === 0) return false;
      const limits = input.limitedUntil[account.id] ?? {};
      if (Object.values(limits).some((resetAt) => Date.parse(resetAt) > input.now)) return false;
      if (exhaustedWindow(account.usageLimits, input.now)) return false;
      const models = account.models;
      return !models || input.modelsInUse.every((model) => models.includes(model));
    })
    .toSorted((a, b) => weeklyReset(a) - weeklyReset(b) || room(b) - room(a))
    .at(0);
};

export interface ClaudeAccountsOptions {
  readonly instanceId: ProviderInstanceId;
  /** The Claude folder all sessions use. */
  readonly folder: string;
  /** The folder's `.claude.json` (for ~/.claude it is ~/.claude.json). */
  readonly profileFile: string;
  readonly storeDir: string;
  readonly platform: NodeJS.Platform;
  readonly locks?: ClaudeLocks;
  /** Usage and models of a stored account, checked with Claude itself in its store folder. */
  readonly probeStored: (
    accountDir: string,
  ) => Effect.Effect<StoredAccountProbe, ClaudeAccountStoreError>;
  /** A `claude` command with CLAUDE_CONFIG_DIR set to `configDir`. */
  readonly runClaude: (
    configDir: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<{ readonly code: number }, ClaudeAccountStoreError>;
  readonly activeSnapshot: Effect.Effect<ServerProvider>;
  readonly refreshActive: Effect.Effect<void>;
}

export interface ClaudeAccounts {
  readonly snapshot: Effect.Effect<ProviderAccountsSnapshot>;
  readonly changes: Stream.Stream<ProviderAccountsSnapshot>;
  readonly refresh: Effect.Effect<void>;
  readonly use: (
    accountId: string,
    initiator: SwitchInitiator,
  ) => Effect.Effect<ProviderAccountsSnapshot, ProviderAccountsError>;
  readonly remove: (
    accountId: string,
  ) => Effect.Effect<ProviderAccountsSnapshot, ProviderAccountsError>;
  readonly rename: (
    accountId: string,
    name: string,
  ) => Effect.Effect<ProviderAccountsSnapshot, ProviderAccountsError>;
  readonly setAutoSwitch: (
    accountId: string,
    enabled: boolean,
  ) => Effect.Effect<ProviderAccountsSnapshot, ProviderAccountsError>;
  readonly checkUsage: (accountId: string | null) => Effect.Effect<ProviderAccountsSnapshot>;
  readonly resumeAutoSwitch: Effect.Effect<ProviderAccountsSnapshot>;
  readonly switchForLimit: ProviderAccountsController["switchForLimit"];
  readonly adoptSignIn: (
    scratchDir: string,
    expectedId: string | null,
  ) => Effect.Effect<string, ProviderAccountsError>;
  readonly activeId: Effect.Effect<string | null>;
  readonly newScratchDir: Effect.Effect<string, ProviderAccountsError>;
  readonly removeScratchDir: (dir: string) => Effect.Effect<void>;
}

export const makeClaudeAccounts = Effect.fn("ClaudeAccounts.make")(function* (
  options: ClaudeAccountsOptions,
): Effect.fn.Return<ClaudeAccounts, never, FileSystem.FileSystem | Path.Path | Scope.Scope> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Scope.Scope;
  const store: ClaudeAccountStore = yield* makeClaudeAccountStore({
    folder: options.folder,
    storeDir: options.storeDir,
    ...(options.locks ? { locks: options.locks } : {}),
  });
  const indexFile = path.join(options.storeDir, "index.json");
  const failure = (operation: string, detail: string) =>
    new ProviderAccountsError({ instanceId: options.instanceId, operation, detail });
  const nowMs = DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const readJsonFile = (file: string) =>
    fileSystem.readFileString(file).pipe(
      Effect.flatMap(decodeJson),
      Effect.map(asRecord),
      Effect.orElseSucceed((): Record<string, unknown> => ({})),
    );
  const index = yield* Ref.make<StoreIndex>({
    ...EMPTY_INDEX,
    ...((yield* readJsonFile(indexFile)) as Partial<StoreIndex>),
  });
  const writeIndex = (next: StoreIndex) =>
    Ref.set(index, next).pipe(
      Effect.andThen(store.writeJson(indexFile, next as unknown as Record<string, unknown>)),
      Effect.ignore,
    );
  const probes = yield* Ref.make<ReadonlyMap<string, ProbeState>>(new Map());
  const runtime = yield* Ref.make<{
    readonly switching: ProviderAccountsSnapshot["switching"];
    readonly lastError: ProviderAccountsSnapshot["lastError"];
  }>({ switching: null, lastError: null });
  const switchLock = yield* Semaphore.make(1);
  const readProfile = (file: string) =>
    readJsonFile(file).pipe(Effect.map((json) => asRecord(json.oauthAccount)));
  const activeLogin = store.activeLogin.pipe(Effect.orElseSucceed(() => undefined));
  const storedLogin = (id: string) =>
    store.storedLogin(id).pipe(Effect.orElseSucceed(() => undefined));

  const uniqueName = (wanted: string, taken: ReadonlyArray<string>) => {
    if (!taken.includes(wanted)) return wanted;
    let n = 2;
    while (taken.includes(`${wanted} ${n}`)) n++;
    return `${wanted} ${n}`;
  };

  /** Brings the index in line with the logins that exist: the folder's and the store's. */
  const syncIndex = Effect.fn("ClaudeAccounts.syncIndex")(function* () {
    const current = yield* Ref.get(index);
    const active = yield* activeLogin;
    const storedIds = yield* store.storedIds.pipe(Effect.orElseSucceed((): string[] => []));
    const additions: IndexEntry[] = [];
    const known = new Set(current.accounts.map((entry) => entry.id));
    const candidates = [
      ...(active ? [{ id: active.accountId, profile: options.profileFile, login: active }] : []),
      ...storedIds.map((id) => ({ id, profile: path.join(store.accountDir(id), ".claude.json") })),
    ];
    for (const candidate of candidates) {
      if (known.has(candidate.id)) continue;
      const login = "login" in candidate ? candidate.login : yield* storedLogin(candidate.id);
      if (!login) continue;
      const profile = yield* readProfile(candidate.profile);
      const organizationKind = organizationKindOf(profile.organizationType ?? profile.billingType);
      const plan = claudePlanLabel(login.subscriptionType, login.rateLimitTier);
      const organizationName = text(profile.organizationName);
      const wanted =
        (organizationKind === "team" || organizationKind === "enterprise"
          ? organizationName
          : null) ??
        plan ??
        "Claude account";
      additions.push({
        id: candidate.id,
        name: uniqueName(
          wanted,
          [...current.accounts, ...additions].map((entry) => entry.name),
        ),
        email: text(profile.emailAddress),
        organizationUuid: login.organizationUuid,
        organizationName,
        organizationKind,
        plan,
        autoSwitch: true,
        addedAt: yield* nowIso,
      });
      known.add(candidate.id);
    }
    if (additions.length > 0) {
      yield* writeIndex({ ...current, accounts: [...current.accounts, ...additions] });
    }
  });

  const snapshotRef = yield* SubscriptionRef.make<ProviderAccountsSnapshot>({
    supported: false,
    unsupportedReason: null,
    accounts: [],
    switching: null,
    lastError: null,
    autoSwitch: { targetId: null, blockedReason: null, pausedUntil: null },
    history: [],
  });

  const supportReason = (version: string | null) =>
    options.platform === "darwin"
      ? "On macOS Claude keeps its login in the keychain, so T3 manages one Claude account here."
      : options.platform === "win32"
        ? "Signing in from T3 isn't available on Windows yet, so T3 manages one Claude account here."
        : version && !claudeVersionSupportsSwitching(version)
          ? `Switching is off for Claude ${version} until it is checked. Update T3.`
          : null;

  const render = Effect.fn("ClaudeAccounts.render")(function* () {
    const current = yield* Ref.get(index);
    const probeStates = yield* Ref.get(probes);
    const active = yield* activeLogin;
    const activeProvider = yield* options.activeSnapshot;
    const now = yield* nowMs;
    const reason = supportReason(activeProvider.version ?? null);
    const accounts: ProviderAccount[] = [];
    for (const entry of current.accounts) {
      const isActive = active?.accountId === entry.id;
      const login = isActive ? active : yield* storedLogin(entry.id);
      const probe = probeStates.get(entry.id);
      const usageLimits = isActive
        ? (activeProvider.usageLimits ?? null)
        : (probe?.usageLimits ?? null);
      const state: ProviderAccount["state"] = !login
        ? "signed-out"
        : isActive && activeProvider.auth.status === "unauthenticated"
          ? "expired"
          : isActive
            ? "ready"
            : (probe?.state ?? "ready");
      accounts.push({
        id: entry.id,
        name: entry.name,
        email: entry.email,
        organizationUuid: entry.organizationUuid,
        organizationName: entry.organizationName,
        organizationKind: entry.organizationKind,
        plan:
          (login ? claudePlanLabel(login.subscriptionType, login.rateLimitTier) : null) ??
          entry.plan,
        active: isActive,
        state,
        stateMessage: isActive ? null : (probe?.stateMessage ?? null),
        signInEndsAt: login?.signInEndsAt ?? null,
        autoSwitch: entry.autoSwitch,
        models: isActive
          ? activeProvider.models.length > 0
            ? activeProvider.models.map((model) => model.slug)
            : null
          : probe?.models
            ? [...probe.models]
            : null,
        usageLimits,
        usageCheckedAt: isActive
          ? (usageLimits?.checkedAt ?? null)
          : (probe?.usageCheckedAt ?? null),
        usageError: isActive ? null : (probe?.usageError ?? null),
      });
    }
    const { switching, lastError } = yield* Ref.get(runtime);
    const paused = current.pausedUntil !== null && Date.parse(current.pausedUntil) > now;
    const ready = accounts.filter((account) => account.state === "ready");
    const target = pickAccountSwitchTarget({
      accounts,
      limitedUntil: current.limitedUntil,
      now,
      modelsInUse: [],
      windowId: null,
    });
    const blockedReason: ProviderAccountsSnapshot["autoSwitch"]["blockedReason"] = paused
      ? "paused"
      : ready.length < 2
        ? "one_account"
        : target
          ? null
          : "no_candidate";
    return {
      supported: reason === null,
      unsupportedReason: reason,
      accounts,
      switching,
      lastError,
      autoSwitch: {
        targetId: blockedReason === null ? (target?.id ?? null) : null,
        blockedReason,
        pausedUntil: paused ? current.pausedUntil : null,
      },
      history: current.history,
    } satisfies ProviderAccountsSnapshot;
  });

  const publish = render().pipe(Effect.flatMap((next) => SubscriptionRef.set(snapshotRef, next)));
  const refresh = syncIndex().pipe(Effect.andThen(publish));

  const setProbe = (id: string, update: (previous: ProbeState) => ProbeState) =>
    Ref.update(probes, (map) => new Map(map).set(id, update(map.get(id) ?? EMPTY_PROBE)));

  const probeOne = Effect.fn("ClaudeAccounts.probe")(function* (id: string) {
    const start = yield* nowMs;
    yield* setProbe(id, (previous) => ({
      ...previous,
      probing: true,
      nextProbeAt: start + INACTIVE_PROBE_TTL_MS,
    }));
    const result = yield* options.probeStored(store.accountDir(id)).pipe(Effect.result);
    const finished = yield* nowMs;
    if (result._tag === "Success") {
      yield* setProbe(id, () => ({
        usageLimits: result.success.usageLimits ?? null,
        usageCheckedAt: isoOf(finished),
        usageError: null,
        models: result.success.models ?? null,
        state: "ready",
        stateMessage: null,
        nextProbeAt: finished + INACTIVE_PROBE_TTL_MS,
        failures: 0,
        probing: false,
      }));
    } else {
      const message = result.failure.detail;
      const authFailure = /auth|401|token|log ?in|invalid_grant|credential/i.test(message);
      yield* setProbe(id, (previous) => {
        const failures = previous.failures + 1;
        return {
          ...previous,
          usageError: authFailure ? null : message.slice(0, 300),
          state: authFailure ? "expired" : previous.state,
          nextProbeAt:
            finished + PROBE_BACKOFF_MS[Math.min(failures, PROBE_BACKOFF_MS.length) - 1]!,
          failures,
          probing: false,
        };
      });
    }
    yield* publish;
  });

  const dueProbes = Effect.fn("ClaudeAccounts.dueProbes")(function* () {
    if ((yield* Ref.get(runtime)).switching) return;
    const now = yield* nowMs;
    const current = yield* Ref.get(index);
    const states = yield* Ref.get(probes);
    const running = [...states.values()].filter((state) => state.probing).length;
    const active = yield* activeLogin;
    const due: string[] = [];
    for (const entry of current.accounts) {
      if (entry.id === active?.accountId) continue;
      const state = states.get(entry.id);
      if (state?.probing || (state && state.nextProbeAt > now)) continue;
      if (yield* storedLogin(entry.id)) due.push(entry.id);
    }
    // At most two at once; the rest wait for the next tick, which staggers them.
    for (const id of due.slice(0, Math.max(0, MAX_PARALLEL_PROBES - running))) {
      yield* Effect.forkIn(probeOne(id).pipe(Effect.ignore), scope);
    }
  });

  const nameOf = (current: StoreIndex, id: string | undefined) =>
    current.accounts.find((entry) => entry.id === id)?.name ?? null;

  /** Runs the switch; the caller holds `switchLock`. */
  const switchNow = Effect.fn("ClaudeAccounts.switchNow")(function* (
    targetId: string,
    reason: ProviderAccountSwitchEntry["reason"],
    window: string | null,
    initiator: SwitchInitiator,
  ) {
    const fromLogin = yield* activeLogin;
    yield* Ref.set(runtime, {
      switching: {
        fromId: fromLogin?.accountId ?? null,
        toId: targetId,
        startedAt: yield* nowIso,
        initiatorClientId: initiator.clientId,
      },
      lastError: null,
    });
    yield* publish;
    const outcome = yield* store.switchTo(targetId).pipe(Effect.result);
    const at = yield* nowIso;
    if (outcome._tag === "Failure") {
      yield* Ref.set(runtime, {
        switching: null,
        lastError: { at, message: outcome.failure.detail, toId: targetId },
      });
      yield* publish;
      return yield* failure("use", outcome.failure.detail);
    }
    const latest = yield* Ref.get(index);
    const entry: ProviderAccountSwitchEntry = {
      at,
      fromId: fromLogin?.accountId ?? null,
      toId: targetId,
      fromName: nameOf(latest, fromLogin?.accountId),
      toName: nameOf(latest, targetId) ?? "Claude account",
      reason,
      window,
      initiator,
    };
    yield* writeIndex({ ...latest, history: [entry, ...latest.history].slice(0, HISTORY_LIMIT) });
    yield* Ref.set(runtime, { switching: null, lastError: null });
    // The account that just left is checked at once, so its row shows fresh usage.
    if (fromLogin)
      yield* setProbe(fromLogin.accountId, (previous) => ({ ...previous, nextProbeAt: 0 }));
    yield* options.refreshActive.pipe(Effect.ignore);
    yield* publish;
    yield* dueProbes().pipe(Effect.ignore);
    return entry;
  });

  const use = Effect.fn("ClaudeAccounts.use")(function* (
    accountId: string,
    initiator: SwitchInitiator,
  ) {
    const snapshot = yield* render();
    if (!snapshot.supported) {
      return yield* failure(
        "use",
        snapshot.unsupportedReason ?? "Switching accounts isn't available here.",
      );
    }
    const account = snapshot.accounts.find((candidate) => candidate.id === accountId);
    if (!account) return yield* failure("use", "This account is no longer in the list.");
    if (account.active) return snapshot;
    if (account.state === "signed-out")
      return yield* failure("use", "Sign in to this account first.");
    yield* switchLock.withPermits(1)(switchNow(accountId, "manual", null, initiator));
    return yield* render();
  });

  const mutateEntry = Effect.fn("ClaudeAccounts.mutateEntry")(function* (
    accountId: string,
    update: (entry: IndexEntry) => IndexEntry,
  ) {
    const current = yield* Ref.get(index);
    if (!current.accounts.some((entry) => entry.id === accountId)) {
      return yield* failure("update", "This account is no longer in the list.");
    }
    yield* writeIndex({
      ...current,
      accounts: current.accounts.map((entry) => (entry.id === accountId ? update(entry) : entry)),
    });
    yield* publish;
    return yield* render();
  });

  const rename = Effect.fn("ClaudeAccounts.rename")(function* (accountId: string, name: string) {
    const trimmed = name.trim();
    const current = yield* Ref.get(index);
    if (current.accounts.some((entry) => entry.id !== accountId && entry.name === trimmed)) {
      return yield* failure("rename", `${trimmed} is already used.`);
    }
    return yield* mutateEntry(accountId, (entry) => ({ ...entry, name: trimmed }));
  });

  const setAutoSwitch = (accountId: string, enabled: boolean) =>
    mutateEntry(accountId, (entry) => ({ ...entry, autoSwitch: enabled }));

  const remove = Effect.fn("ClaudeAccounts.remove")(function* (accountId: string) {
    const snapshot = yield* render();
    const account = snapshot.accounts.find((candidate) => candidate.id === accountId);
    if (!account) return snapshot;
    if (account.active) return yield* failure("remove", "Switch to another account first.");
    const dir = store.accountDir(accountId);
    if (yield* fileSystem.exists(dir).pipe(Effect.orElseSucceed(() => false))) {
      // Revokes the login on Claude's side; a failure leaves nothing usable behind anyway.
      yield* options.runClaude(dir, ["auth", "logout"]).pipe(Effect.ignore);
      yield* fileSystem.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore);
    }
    const current = yield* Ref.get(index);
    yield* writeIndex({
      ...current,
      accounts: current.accounts.filter((entry) => entry.id !== accountId),
    });
    yield* Ref.update(probes, (map) => {
      const next = new Map(map);
      next.delete(accountId);
      return next;
    });
    yield* publish;
    return yield* render();
  });

  const checkUsage = Effect.fn("ClaudeAccounts.checkUsage")(function* (accountId: string | null) {
    const active = yield* activeLogin;
    const current = yield* Ref.get(index);
    const ids = accountId === null ? current.accounts.map((entry) => entry.id) : [accountId];
    if (active && ids.includes(active.accountId)) yield* options.refreshActive.pipe(Effect.ignore);
    yield* Effect.forEach(
      ids.filter((id) => id !== active?.accountId),
      (id) => probeOne(id).pipe(Effect.ignore),
      { concurrency: MAX_PARALLEL_PROBES },
    );
    yield* publish;
    return yield* render();
  });

  const resumeAutoSwitch = Effect.gen(function* () {
    const current = yield* Ref.get(index);
    yield* writeIndex({ ...current, pausedUntil: null, autoSwitchLog: [] });
    yield* publish;
    return yield* render();
  });

  const noteLimited = Effect.fn("ClaudeAccounts.noteLimited")(function* (
    accountId: string,
    windowId: string,
    resetAt: string,
  ) {
    const current = yield* Ref.get(index);
    yield* writeIndex({
      ...current,
      limitedUntil: {
        ...current.limitedUntil,
        [accountId]: { ...current.limitedUntil[accountId], [windowId]: resetAt },
      },
    });
    yield* publish;
  });

  /** The account that was active at `atMs`, walking back through the switches made since. */
  const activeAt = (history: StoreIndex["history"], currentId: string | null, atMs: number) => {
    let account = currentId;
    for (const entry of history) {
      if (Date.parse(entry.at) <= atMs) break;
      account = entry.fromId;
    }
    return account;
  };

  const switchForLimit = Effect.fn("ClaudeAccounts.switchForLimit")(function* (input: {
    readonly failedAt: string | null;
    readonly windowId: string | null;
    readonly windowLabel: string | null;
    readonly resetAt: string | null;
    readonly modelsInUse: ReadonlyArray<string>;
  }) {
    return yield* switchLock.withPermits(1)(
      Effect.gen(function* () {
        const snapshot = yield* render();
        if (!snapshot.supported) return undefined;
        const now = yield* nowMs;
        const before = yield* Ref.get(index);
        const active = snapshot.accounts.find((account) => account.active);
        const failedId = activeAt(
          before.history,
          active?.id ?? null,
          input.failedAt ? Date.parse(input.failedAt) : now,
        );
        if (failedId && input.resetAt) {
          const key = input.windowId ?? "limit";
          if (before.limitedUntil[failedId]?.[key] !== input.resetAt) {
            yield* noteLimited(failedId, key, input.resetAt);
          }
        }
        const nameOfId = (id: string | null | undefined) =>
          before.accounts.find((entry) => entry.id === id)?.name ?? "Claude";
        // Someone switched since the failure: the thread just continues on the active account.
        if (active && failedId && active.id !== failedId) {
          return { fromName: nameOfId(failedId), toName: active.name };
        }
        const current = yield* Ref.get(index);
        if (current.pausedUntil && Date.parse(current.pausedUntil) > now) return undefined;
        const rendered = yield* render();
        const target = pickAccountSwitchTarget({
          accounts: rendered.accounts,
          limitedUntil: current.limitedUntil,
          now,
          modelsInUse: input.modelsInUse,
          windowId: input.windowId,
        });
        if (!target) return undefined;
        const recent = current.autoSwitchLog.filter((at) => now - Date.parse(at) < HOUR_MS);
        if (recent.length >= AUTO_SWITCH_CAP_PER_HOUR) {
          yield* writeIndex({ ...current, pausedUntil: isoOf(now + HOUR_MS) });
          yield* publish;
          return undefined;
        }
        yield* writeIndex({ ...current, autoSwitchLog: [...recent, isoOf(now)] });
        const switched = yield* switchNow(target.id, "usage_limit", input.windowLabel, {
          clientId: null,
          kind: "server",
        }).pipe(Effect.result);
        return switched._tag === "Success"
          ? { fromName: nameOfId(failedId), toName: target.name }
          : undefined;
      }),
    );
  });

  /**
   * Takes over a login that a sign-in left in `scratchDir`: a new account is stored inactive (or
   * becomes active when none is), a known one gets the new login. Returns the flow's message.
   */
  const adoptSignIn = Effect.fn("ClaudeAccounts.adoptSignIn")(function* (
    scratchDir: string,
    expectedId: string | null,
  ) {
    const credentials = yield* readJsonFile(path.join(scratchDir, ".credentials.json"));
    const login = describeLogin(credentials);
    if (!login) return yield* failure("signIn", "Claude did not save a sign-in. Try again.");
    const before = yield* Ref.get(index);
    const known = before.accounts.some((entry) => entry.id === login.accountId);
    const wasActive = (yield* activeLogin)?.accountId;
    yield* store
      .storeLogin(credentials)
      .pipe(Effect.mapError((error) => failure("signIn", error.detail)));
    if (wasActive !== undefined && wasActive !== login.accountId) {
      // A stored login keeps its profile beside it, so its row has an email and organization.
      const profile = yield* readJsonFile(path.join(scratchDir, ".claude.json"));
      yield* store
        .writeJson(path.join(store.accountDir(login.accountId), ".claude.json"), {
          hasCompletedOnboarding: true,
          oauthAccount: profile.oauthAccount,
          userID: profile.userID,
        })
        .pipe(Effect.ignore);
    }
    const pending = expectedId?.startsWith("pending:")
      ? before.accounts.find((entry) => entry.id === expectedId)
      : undefined;
    if (pending && !known) {
      // A migrated account without a login becomes this account, keeping its name and switch flag.
      yield* Ref.update(index, (current) => ({
        ...current,
        accounts: current.accounts.filter((entry) => entry.id !== pending.id),
      }));
    }
    yield* syncIndex();
    if (pending && !known) {
      const current = yield* Ref.get(index);
      yield* writeIndex({
        ...current,
        accounts: current.accounts.map((entry) =>
          entry.id === login.accountId
            ? { ...entry, name: pending.name, autoSwitch: pending.autoSwitch }
            : entry,
        ),
      });
    }
    yield* setProbe(login.accountId, (previous) => ({
      ...previous,
      state: "ready",
      stateMessage: null,
      nextProbeAt: 0,
    }));
    if (wasActive === undefined || wasActive === login.accountId) {
      yield* options.refreshActive.pipe(Effect.ignore);
    }
    yield* publish;
    yield* dueProbes().pipe(Effect.ignore);
    const after = yield* Ref.get(index);
    const name = nameOf(after, login.accountId) ?? "Claude account";
    if (expectedId && !pending && expectedId !== login.accountId) {
      const expectedName = nameOf(before, expectedId) ?? "the expected account";
      return `Signed in as ${name}, not ${expectedName}. ${name} was ${known ? "renewed" : "added"}.`;
    }
    return known ? `Renewed the sign-in for ${name}.` : `Added ${name}.`;
  });

  const newScratchDir = Effect.gen(function* () {
    const dir = path.join(options.storeDir, `pending-${yield* nowMs}-${(scratchCount += 1)}`);
    yield* fileSystem
      .makeDirectory(dir, { recursive: true, mode: 0o700 })
      .pipe(Effect.mapError(() => failure("signIn", "Could not prepare the sign-in folder.")));
    return dir;
  });

  yield* store.reconcile.pipe(Effect.ignore);
  yield* refresh.pipe(Effect.ignore);
  // Stored accounts are checked in the background; the folder is watched for outside changes.
  yield* Effect.forkScoped(
    dueProbes().pipe(
      Effect.andThen(publish),
      Effect.ignore,
      Effect.repeat(Schedule.spaced("1 minute")),
    ),
  );
  yield* Effect.forkScoped(
    fileSystem.watch(options.folder).pipe(
      Stream.filter((event) => event.path.endsWith(".credentials.json")),
      Stream.debounce("1 second"),
      Stream.runForEach(() => refresh.pipe(Effect.ignore)),
      Effect.ignore,
    ),
  );

  return {
    snapshot: SubscriptionRef.get(snapshotRef),
    changes: SubscriptionRef.changes(snapshotRef),
    refresh: refresh.pipe(Effect.ignore),
    use,
    remove,
    rename,
    setAutoSwitch,
    checkUsage,
    resumeAutoSwitch,
    switchForLimit,
    adoptSignIn,
    activeId: activeLogin.pipe(Effect.map((login) => login?.accountId ?? null)),
    newScratchDir,
    removeScratchDir: (dir) =>
      fileSystem.remove(dir, { recursive: true, force: true }).pipe(Effect.ignore),
  } satisfies ClaudeAccounts;
});
