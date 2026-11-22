import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAccount, type ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeClaudeAccounts, pickAccountSwitchTarget } from "./ClaudeAccounts.ts";
import { ClaudeAccountStoreError } from "./ClaudeAccountStore.ts";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const account = (
  id: string,
  windows: ReadonlyArray<{
    id: string;
    kind: "session" | "weekly";
    used: number;
    resetsAt?: string;
    modelIds?: string[];
  }>,
  overrides: Partial<ProviderAccount> = {},
): ProviderAccount => ({
  id,
  name: id,
  email: null,
  organizationUuid: null,
  organizationName: null,
  organizationKind: "personal",
  plan: "Max 20x",
  active: false,
  state: "ready",
  stateMessage: null,
  signInEndsAt: null,
  autoSwitch: true,
  models: ["claude-fable-5-2", "claude-sonnet-5-5"],
  usageLimits: {
    checkedAt: "2026-11-21T11:59:00.000Z",
    windows: windows.map((window) => ({
      id: window.id,
      kind: window.kind,
      label: window.id,
      usedPercent: window.used,
      ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
      ...(window.modelIds ? { modelIds: window.modelIds } : {}),
    })),
  },
  usageCheckedAt: "2026-11-21T11:59:00.000Z",
  usageError: null,
  ...overrides,
});
const pick = (
  accounts: ReadonlyArray<ProviderAccount>,
  extra: Partial<Parameters<typeof pickAccountSwitchTarget>[0]> = {},
) =>
  pickAccountSwitchTarget({
    accounts,
    limitedUntil: {},
    now: NOW,
    modelsInUse: [],
    windowId: "five_hour",
    ...extra,
  })?.id;

describe("pickAccountSwitchTarget", () => {
  it("prefers the account whose weekly budget resets first, among those with room", () => {
    const early = account("early", [
      { id: "five_hour", kind: "session", used: 40 },
      { id: "seven_day", kind: "weekly", used: 70, resetsAt: "2026-11-22T00:00:00.000Z" },
    ]);
    const late = account("late", [
      { id: "five_hour", kind: "session", used: 0 },
      { id: "seven_day", kind: "weekly", used: 10, resetsAt: "2026-11-27T00:00:00.000Z" },
    ]);
    expect(pick([late, early])).toBe("early");
  });

  it("skips the active, exhausted, signed-out, excluded and unread accounts", () => {
    const ok = account("ok", [{ id: "five_hour", kind: "session", used: 10 }]);
    expect(
      pick([
        account("active", [{ id: "five_hour", kind: "session", used: 0 }], { active: true }),
        account("full", [
          { id: "five_hour", kind: "session", used: 100, resetsAt: "2026-11-21T14:00:00.000Z" },
        ]),
        account("out", [{ id: "five_hour", kind: "session", used: 0 }], { state: "signed-out" }),
        account("skip", [{ id: "five_hour", kind: "session", used: 0 }], { autoSwitch: false }),
        account("unread", [], { usageLimits: null }),
        ok,
      ]),
    ).toBe("ok");
  });

  it("skips an account known to be limited until its reset, and one missing a model in use", () => {
    const limited = account("limited", [{ id: "five_hour", kind: "session", used: 10 }]);
    const noFable = account("no-fable", [{ id: "five_hour", kind: "session", used: 10 }], {
      models: ["claude-sonnet-5-5"],
    });
    expect(
      pick([limited, noFable], {
        limitedUntil: { limited: { five_hour: "2026-11-21T13:00:00.000Z" } },
        modelsInUse: ["claude-fable-5-2"],
      }),
    ).toBeUndefined();
    expect(
      pick([limited], { limitedUntil: { limited: { five_hour: "2026-11-21T11:00:00.000Z" } } }),
    ).toBe("limited");
  });

  it("treats an exhausted per-model window as no room", () => {
    const fableOut = account("fable-out", [
      { id: "five_hour", kind: "session", used: 0 },
      {
        id: "fable",
        kind: "weekly",
        used: 100,
        resetsAt: "2026-11-25T00:00:00.000Z",
        modelIds: ["claude-fable-5-2"],
      },
    ]);
    expect(pick([fableOut])).toBeUndefined();
  });
});

const login = (accountUuid: string, organizationUuid: string, refreshToken: string) => ({
  claudeAiOauth: {
    accessToken: `access-${refreshToken}`,
    refreshToken,
    expiresAt: 4_102_444_800_000,
    scopes: ["user:inference"],
    accountUuid,
    organizationUuid,
    subscriptionType: "max",
  },
  organizationUuid,
});

/** A Claude folder with A signed in and B, C stored; C's probe fails with a timeout. */
const service = Effect.fn("service")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-service-" });
  const folder = path.join(root, "claude");
  const storeDir = path.join(root, "store");
  const write = (file: string, value: unknown) =>
    fileSystem
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(Effect.andThen(fileSystem.writeFileString(file, JSON.stringify(value))));
  yield* write(path.join(folder, ".credentials.json"), login("acct-a", "org", "rt-a"));
  yield* write(
    path.join(storeDir, "acct-b.org", ".credentials.json"),
    login("acct-b", "org", "rt-b"),
  );
  yield* write(
    path.join(storeDir, "acct-c.org", ".credentials.json"),
    login("acct-c", "org", "rt-c"),
  );
  const probed: string[] = [];
  const accounts = yield* makeClaudeAccounts({
    instanceId: ProviderInstanceId.make("claudeAgent"),
    folder,
    profileFile: path.join(root, ".claude.json"),
    storeDir,
    platform: "linux",
    locks: { withLocks: (_dir, effect) => effect },
    probeStored: (accountDir) => {
      probed.push(path.basename(accountDir));
      return accountDir.endsWith("acct-c.org")
        ? Effect.fail(new ClaudeAccountStoreError({ operation: "probe", detail: "timed out" }))
        : Effect.succeed({
            models: ["claude-fable-5-2"],
            usageLimits: {
              checkedAt: "2026-11-21T12:00:00.000Z",
              windows: [{ id: "five_hour", kind: "session", label: "5-hour", usedPercent: 20 }],
            },
          });
    },
    runClaude: () => Effect.succeed({ code: 0 }),
    // The active account is out of usage until long after the test clock.
    activeSnapshot: Effect.succeed({
      version: "2.1.328",
      auth: { status: "authenticated" },
      models: [{ slug: "claude-fable-5-2" }],
      usageLimits: {
        checkedAt: "2026-11-21T12:00:00.000Z",
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "5-hour",
            usedPercent: 100,
            resetsAt: "2100-01-01T00:00:00.000Z",
          },
        ],
      },
    } as unknown as ServerProvider),
    refreshActive: Effect.void,
  });
  const folderToken = fileSystem
    .readFileString(path.join(folder, ".credentials.json"))
    .pipe(Effect.map((text) => JSON.parse(text).claudeAiOauth.refreshToken as string));
  return { accounts, probed, folderToken };
});

it.layer(NodeServices.layer)("makeClaudeAccounts", (it) => {
  describe("stored accounts are probed and switched to at a limit", () => {
    it.effect("a probe's usage lands on its row; a failed probe shows its reason", () =>
      Effect.gen(function* () {
        const t = yield* service();
        const snapshot = yield* t.accounts.checkUsage(null);
        const row = (id: string) => snapshot.accounts.find((account) => account.id === id);
        expect(row("acct-b.org")?.usageLimits?.windows[0]?.usedPercent).toBe(20);
        expect(row("acct-c.org")?.usageError).toBe("timed out");
        expect(row("acct-c.org")?.state).toBe("ready");
        expect(t.probed).toContain("acct-b.org");
      }),
    );

    it.effect(
      "switches from the limited account, and a later failure report doesn't switch again",
      () =>
        Effect.gen(function* () {
          const t = yield* service();
          yield* t.accounts.checkUsage(null);
          const failedAt = DateTime.formatIso(yield* DateTime.now);
          const input = {
            failedAt,
            windowId: "five_hour",
            windowLabel: "5-hour",
            resetAt: "2100-01-01T00:00:00.000Z",
            modelsInUse: ["claude-fable-5-2"],
          };
          const first = yield* t.accounts.switchForLimit(input);
          expect(first).toBeDefined();
          expect(yield* t.folderToken).toBe("rt-b");
          const after = yield* t.accounts.snapshot;
          expect(after.history[0]?.reason).toBe("usage_limit");
          // The same failure seen again (another thread, the sweep): the thread continues on B.
          const second = yield* t.accounts.switchForLimit(input);
          expect(second).toEqual(first);
          expect(yield* t.folderToken).toBe("rt-b");
        }),
    );
  });
});
