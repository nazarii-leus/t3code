// @effect-diagnostics nodeBuiltinImport:off - Claude's own lock files coordinate with Claude processes.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import { lock } from "proper-lockfile";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * The keys Claude Code's own logout removes from `.credentials.json` (2.1.328). Everything else in
 * that file (MCP sign-ins, plugin secrets) belongs to the folder and never moves.
 */
const CLAUDE_LOGIN_KEYS = [
  "claudeAiOauth",
  "organizationUuid",
  "trustedDeviceToken",
  "trustedDeviceEnrolledAfterRefusalAtMs",
  "enterpriseGateway",
  "designOauth",
  "cloudSessionsOauth",
  "cloudSessionsSignInEnded",
] as const;

const CREDENTIALS_FILE = ".credentials.json";
const JOURNAL_FILE = "journal.json";

export class ClaudeAccountStoreError extends Schema.TaggedError<ClaudeAccountStoreError>()(
  "ClaudeAccountStoreError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const JsonValue = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownEffect(JsonValue);
const encodeJson = Schema.encodeEffect(JsonValue);
let pendingWrites = 0;

export interface ClaudeLocks {
  /** Runs `effect` while holding the locks Claude takes on `dir` before it writes credentials. */
  readonly withLocks: <A, E, R>(
    dir: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ClaudeAccountStoreError, R>;
}

const lockFailure = (cause: unknown) =>
  new ClaudeAccountStoreError({
    operation: "lock",
    detail: "Claude is busy renewing its sign-in. Try again in a minute.",
    cause,
  });

const acquire = (file: string, options: Parameters<typeof lock>[1]) =>
  Effect.acquireRelease(
    Effect.tryPromise({ try: () => lock(file, options), catch: lockFailure }),
    (release) => Effect.promise(() => release()).pipe(Effect.ignore),
  );

/**
 * Claude 2.1.328 refreshes under `<dir>/.oauth_refresh.lock` and the legacy `<realpath>.lock`, and
 * writes credentials under `<dir>/.storage-write.lock`. A request that waits more than ~8 s for the
 * refresh lock fails (step 1), so callers hold these for milliseconds only.
 */
const claudeLocks: ClaudeLocks = {
  withLocks: (dir, effect) =>
    Effect.scoped(
      Effect.gen(function* () {
        const real = yield* Effect.tryPromise({
          try: () => import("node:fs/promises").then((fs) => fs.realpath(dir)),
          catch: lockFailure,
        });
        const refresh = {
          realpath: false,
          stale: 60_000,
          update: 5_000,
          retries: { retries: 60, factor: 1, minTimeout: 250, maxTimeout: 250 },
        } as const;
        // proper-lockfile keys its registry by the file argument, so each lock gets its own.
        yield* acquire(NodePath.join(dir, ".oauth_refresh"), {
          ...refresh,
          lockfilePath: NodePath.join(dir, ".oauth_refresh.lock"),
        });
        yield* acquire(real, { ...refresh, lockfilePath: `${real}.lock` });
        yield* acquire(NodePath.join(dir, ".storage-write"), {
          realpath: false,
          stale: 15_000,
          retries: { retries: 60, factor: 1, minTimeout: 100, maxTimeout: 100 },
        });
        return yield* effect;
      }),
    ),
};

type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};

const pickLoginSet = (credentials: Json): Json =>
  Object.fromEntries(
    CLAUDE_LOGIN_KEYS.filter((key) => key in credentials).map((key) => [key, credentials[key]]),
  );
const withoutLoginSet = (credentials: Json): Json =>
  Object.fromEntries(
    Object.entries(credentials).filter(
      ([key]) => !(CLAUDE_LOGIN_KEYS as ReadonlyArray<string>).includes(key),
    ),
  );

export interface ClaudeLogin {
  readonly accountId: string;
  readonly accountUuid: string;
  readonly organizationUuid: string;
  readonly refreshTokenHash: string;
  readonly expiresAt: number | undefined;
  readonly signInEndsAt: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly rateLimitTier: string | undefined;
}

const hash = (value: string) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 12);

const claudeAccountId = (accountUuid: string, organizationUuid: string) =>
  `${accountUuid}.${organizationUuid}`;

/** Reads the login set's identity; never returns a token. */
export const describeLogin = (credentials: Json): ClaudeLogin | undefined => {
  const oauth = asRecord(credentials.claudeAiOauth);
  const accountUuid = typeof oauth.accountUuid === "string" ? oauth.accountUuid : undefined;
  const organizationUuid =
    typeof oauth.organizationUuid === "string"
      ? oauth.organizationUuid
      : typeof credentials.organizationUuid === "string"
        ? credentials.organizationUuid
        : undefined;
  const refreshToken = typeof oauth.refreshToken === "string" ? oauth.refreshToken : undefined;
  if (!accountUuid || !organizationUuid || !refreshToken) return undefined;
  const ends =
    typeof oauth.refreshTokenExpiresAt === "number" ? oauth.refreshTokenExpiresAt : undefined;
  return {
    accountId: claudeAccountId(accountUuid, organizationUuid),
    accountUuid,
    organizationUuid,
    refreshTokenHash: hash(refreshToken),
    expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined,
    signInEndsAt: ends === undefined ? undefined : DateTime.formatIso(DateTime.makeUnsafe(ends)),
    subscriptionType:
      typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : undefined,
    rateLimitTier: typeof oauth.rateLimitTier === "string" ? oauth.rateLimitTier : undefined,
  };
};

export interface ClaudeAccountStoreOptions {
  /** The Claude folder every session uses (CLAUDE_CONFIG_DIR, or ~/.claude). */
  readonly folder: string;
  /** T3's private store for this folder. */
  readonly storeDir: string;
  readonly locks?: ClaudeLocks;
}

export const makeClaudeAccountStore = Effect.fn("ClaudeAccountStore.make")(function* (
  options: ClaudeAccountStoreOptions,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const locks = options.locks ?? claudeLocks;
  const failure = (operation: string, detail: string) => (cause: unknown) =>
    new ClaudeAccountStoreError({ operation, detail, cause });

  const folderFile = path.join(options.folder, CREDENTIALS_FILE);
  const journalFile = path.join(options.storeDir, JOURNAL_FILE);
  const accountDir = (accountId: string) => path.join(options.storeDir, accountId);
  const storedFile = (accountId: string) => path.join(accountDir(accountId), CREDENTIALS_FILE);

  const readJson = Effect.fn("ClaudeAccountStore.readJson")(function* (file: string) {
    const text = yield* fileSystem.readFileString(file).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("{}")),
      Effect.mapError(failure("read", `Could not read ${path.basename(file)}.`)),
    );
    return asRecord(
      yield* decodeJson(text).pipe(
        Effect.mapError(failure("read", `${path.basename(file)} is not JSON.`)),
      ),
    );
  });
  const writeJson = Effect.fn("ClaudeAccountStore.writeJson")(
    function* (file: string, value: Json) {
      yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
      const pending = `${file}.t3-${process.pid}-${(pendingWrites += 1)}`;
      yield* fileSystem.writeFileString(pending, yield* encodeJson(value), { mode: 0o600 });
      yield* fileSystem
        .rename(pending, file)
        .pipe(Effect.tapError(() => fileSystem.remove(pending).pipe(Effect.ignore)));
    },
    (effect, file) =>
      effect.pipe(Effect.mapError(failure("write", `Could not write ${path.basename(file)}.`))),
  );
  const removeStored = (accountId: string) =>
    fileSystem
      .remove(storedFile(accountId), { force: true })
      .pipe(Effect.mapError(failure("write", "Could not clear a stored sign-in.")));

  const storedIds = fileSystem.readDirectory(options.storeDir).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed<Array<string>>([])),
    Effect.map((names) => names.filter((name) => name.includes(".") && !name.endsWith(".json"))),
    Effect.mapError(failure("read", "Could not read the account store.")),
  );

  const activeLogin = readJson(folderFile).pipe(Effect.map(describeLogin));
  const storedLogin = (accountId: string) =>
    readJson(storedFile(accountId)).pipe(Effect.map(describeLogin));

  const writeJournal = (value: Json) => writeJson(journalFile, value);

  /** Method (ii) from step 1: save the outgoing login set, replace the folder's atomically, clear the incoming copy. */
  const switchTo = Effect.fn("ClaudeAccountStore.switchTo")(function* (targetId: string) {
    const target = yield* storedLogin(targetId);
    if (!target) {
      return yield* new ClaudeAccountStoreError({
        operation: "switch",
        detail: "This account has no stored sign-in. Sign in again.",
      });
    }
    yield* locks.withLocks(
      options.folder,
      locks.withLocks(
        accountDir(targetId),
        Effect.gen(function* () {
          const current = yield* readJson(folderFile);
          const outgoing = describeLogin(current);
          if (outgoing?.accountId === targetId) return;
          const at = DateTime.formatIso(yield* DateTime.now);
          yield* writeJournal({
            fromId: outgoing?.accountId ?? null,
            toId: targetId,
            step: "start",
            at,
          });
          if (outgoing) {
            yield* writeJson(storedFile(outgoing.accountId), pickLoginSet(current));
            yield* writeJournal({
              fromId: outgoing.accountId,
              toId: targetId,
              step: "outgoing-saved",
              at,
            });
          }
          const incoming = pickLoginSet(yield* readJson(storedFile(targetId)));
          yield* writeJson(folderFile, { ...withoutLoginSet(current), ...incoming });
          yield* writeJournal({
            fromId: outgoing?.accountId ?? null,
            toId: targetId,
            step: "installed",
            at,
          });
          yield* removeStored(targetId);
          yield* fileSystem.remove(journalFile, { force: true }).pipe(Effect.ignore);
        }),
      ),
    );
  });

  /**
   * After a crash or an outside change: the folder's login is the one in use and wins; a store copy of
   * the same account goes; a folder left without a login gets the journal's target (or its source).
   * Never deletes the only copy of a login.
   */
  const reconcile = Effect.gen(function* () {
    const journal = yield* readJson(journalFile);
    yield* locks.withLocks(
      options.folder,
      Effect.gen(function* () {
        const current = yield* readJson(folderFile);
        let active = describeLogin(current);
        if (!active) {
          for (const candidate of [journal.toId, journal.fromId]) {
            if (typeof candidate !== "string") continue;
            const stored = yield* readJson(storedFile(candidate));
            if (!describeLogin(stored)) continue;
            yield* writeJson(folderFile, { ...withoutLoginSet(current), ...pickLoginSet(stored) });
            yield* removeStored(candidate);
            active = describeLogin(stored);
            break;
          }
        }
        if (active) yield* removeStored(active.accountId);
      }),
    );
    yield* fileSystem.remove(journalFile, { force: true }).pipe(Effect.ignore);
  });

  /** Saves a login set that a sign-in produced in a scratch folder as a stored (inactive) account. */
  const storeLogin = Effect.fn("ClaudeAccountStore.storeLogin")(function* (credentials: Json) {
    const login = describeLogin(credentials);
    if (!login) {
      return yield* new ClaudeAccountStoreError({
        operation: "store",
        detail: "Claude did not save a sign-in.",
      });
    }
    yield* locks.withLocks(
      options.folder,
      Effect.gen(function* () {
        const current = describeLogin(yield* readJson(folderFile));
        if (current?.accountId === login.accountId) {
          // A new sign-in of the active account replaces the folder's login set.
          const folder = yield* readJson(folderFile);
          yield* writeJson(folderFile, {
            ...withoutLoginSet(folder),
            ...pickLoginSet(credentials),
          });
        } else if (!current) {
          const folder = yield* readJson(folderFile);
          yield* writeJson(folderFile, {
            ...withoutLoginSet(folder),
            ...pickLoginSet(credentials),
          });
        } else {
          yield* writeJson(storedFile(login.accountId), pickLoginSet(credentials));
        }
      }),
    );
    return login;
  });

  return {
    folder: options.folder,
    storeDir: options.storeDir,
    accountDir,
    activeLogin,
    storedIds,
    storedLogin,
    switchTo,
    reconcile,
    storeLogin,
    removeStored,
    readJson,
    writeJson,
  };
});

export type ClaudeAccountStore = Effect.Success<ReturnType<typeof makeClaudeAccountStore>>;
