import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { claudeLocks, makeClaudeAccountStore, type ClaudeLocks } from "./ClaudeAccountStore.ts";

const login = (account: string, org: string, refreshToken: string) => ({
  claudeAiOauth: {
    accessToken: `access-${refreshToken}`,
    refreshToken,
    expiresAt: 4_102_444_800_000,
    refreshTokenExpiresAt: 4_102_444_800_000,
    scopes: ["user:inference", "user:profile"],
    accountUuid: account,
    organizationUuid: org,
    subscriptionType: "max",
  },
  organizationUuid: org,
  trustedDeviceToken: `device-${refreshToken}`,
});
const A = login("acct-a", "org-a", "rt-a");
const B = login("acct-b", "org-b", "rt-b");
const A_ID = "acct-a.org-a";
const B_ID = "acct-b.org-b";
const MCP = { "jira|0000000000000000": { serverName: "jira", accessToken: "mcp-token" } };

const immediateLocks: ClaudeLocks = { withLocks: (_dir, effect) => effect };

const setup = Effect.fn("setup")(function* (locks: ClaudeLocks = immediateLocks) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-accounts-" });
  const folder = path.join(root, "claude");
  const storeDir = path.join(root, "store");
  yield* fileSystem.makeDirectory(folder, { recursive: true });
  yield* fileSystem.makeDirectory(path.join(storeDir, B_ID), { recursive: true });
  const write = (file: string, value: unknown) =>
    fileSystem.writeFileString(file, JSON.stringify(value));
  const read = (file: string) =>
    fileSystem.readFileString(file).pipe(
      Effect.map((text) => JSON.parse(text) as Record<string, unknown>),
      Effect.orElseSucceed(() => undefined),
    );
  yield* write(path.join(folder, ".credentials.json"), {
    ...A,
    mcpOAuth: MCP,
    pluginSecrets: { p: 1 },
  });
  yield* write(path.join(storeDir, B_ID, ".credentials.json"), B);
  const store = yield* makeClaudeAccountStore({ folder, storeDir, locks });
  const folderCredentials = read(path.join(folder, ".credentials.json"));
  const storeCredentials = (id: string) => read(path.join(storeDir, id, ".credentials.json"));
  const refreshTokens = Effect.gen(function* () {
    const places = [
      yield* folderCredentials,
      yield* storeCredentials(A_ID),
      yield* storeCredentials(B_ID),
    ];
    return places
      .map(
        (credentials) =>
          (credentials?.claudeAiOauth as { refreshToken?: string } | undefined)?.refreshToken,
      )
      .filter((token): token is string => token !== undefined)
      .toSorted();
  });
  return {
    fileSystem,
    path,
    folder,
    storeDir,
    store,
    write,
    folderCredentials,
    storeCredentials,
    refreshTokens,
  };
});

it.layer(NodeServices.layer)("ClaudeAccountStore", (it) => {
  describe("a switch keeps one copy of every login", () => {
    it.effect("moves A out, B in, and keeps the folder's other keys", () =>
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.store.switchTo(B_ID);

        const folder = yield* t.folderCredentials;
        expect(folder?.claudeAiOauth).toEqual(B.claudeAiOauth);
        expect(folder?.trustedDeviceToken).toBe(B.trustedDeviceToken);
        expect(folder?.organizationUuid).toBe("org-b");
        expect(folder?.mcpOAuth).toEqual(MCP);
        expect(folder?.pluginSecrets).toEqual({ p: 1 });

        const stored = yield* t.storeCredentials(A_ID);
        expect(stored).toEqual(A);
        expect(yield* t.storeCredentials(B_ID)).toBeUndefined();
        expect(yield* t.refreshTokens).toEqual(["rt-a", "rt-b"]);
      }),
    );

    it.effect("waits for Claude's locks before it reads or writes", () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const locks: ClaudeLocks = {
          withLocks: (_dir, effect) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(effect),
            ),
        };
        const t = yield* setup(locks);
        const fiber = yield* Effect.forkChild(t.store.switchTo(B_ID));
        yield* Deferred.await(entered);
        expect((yield* t.folderCredentials)?.claudeAiOauth).toEqual(A.claudeAiOauth);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(fiber);
        expect((yield* t.folderCredentials)?.claudeAiOauth).toEqual(B.claudeAiOauth);
      }),
    );
  });

  describe("the switch's edges", () => {
    it.effect("waits while Claude holds its refresh lock file", () =>
      Effect.gen(function* () {
        const t = yield* setup(claudeLocks);
        // proper-lockfile marks a held lock with a fresh directory.
        const held = t.path.join(t.folder, ".oauth_refresh.lock");
        yield* t.fileSystem.makeDirectory(held);
        const fiber = yield* Effect.forkChild(t.store.switchTo(B_ID));
        yield* Effect.yieldNow;
        expect((yield* t.folderCredentials)?.claudeAiOauth).toEqual(A.claudeAiOauth);
        yield* t.fileSystem.remove(held, { recursive: true });
        yield* Fiber.join(fiber);
        expect((yield* t.folderCredentials)?.claudeAiOauth).toEqual(B.claudeAiOauth);
        expect(yield* t.refreshTokens).toEqual(["rt-a", "rt-b"]);
      }),
    );

    it.effect("a switch that fails part way is put right at once", () =>
      Effect.gen(function* () {
        const t = yield* setup();
        // The outgoing login is saved, then the folder can't be written.
        yield* t.fileSystem.chmod(t.folder, 0o500);
        const outcome = yield* t.store.switchTo(B_ID).pipe(Effect.result);
        yield* t.fileSystem.chmod(t.folder, 0o700);
        expect(outcome._tag).toBe("Failure");
        expect((yield* t.folderCredentials)?.claudeAiOauth).toEqual(A.claudeAiOauth);
        expect(yield* t.refreshTokens).toEqual(["rt-a", "rt-b"]);
        expect(yield* t.fileSystem.exists(t.path.join(t.storeDir, "journal.json"))).toBe(false);
      }),
    );

    it.effect("a switch to the account already in use does nothing", () =>
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.store.switchTo(A_ID);
        expect((yield* t.folderCredentials)?.claudeAiOauth).toEqual(A.claudeAiOauth);
        expect(yield* t.refreshTokens).toEqual(["rt-a", "rt-b"]);
      }),
    );

    it.effect("a new sign-in is stored without touching the active login", () =>
      Effect.gen(function* () {
        const t = yield* setup();
        const C = login("acct-c", "org-c", "rt-c");
        yield* t.store.storeLogin(C);
        expect((yield* t.folderCredentials)?.claudeAiOauth).toEqual(A.claudeAiOauth);
        expect((yield* t.storeCredentials("acct-c.org-c"))?.claudeAiOauth).toEqual(C.claudeAiOauth);
        expect(yield* t.refreshTokens).toEqual(["rt-a", "rt-b"]);
      }),
    );
  });

  describe("reconciliation goes by what the folder holds", () => {
    const journal = (step: string) => ({
      fromId: A_ID,
      toId: B_ID,
      step,
      at: "2026-11-21T00:00:00.000Z",
    });

    it.effect("crash after start: nothing moved, the journal goes", () =>
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.write(t.path.join(t.storeDir, "journal.json"), journal("start"));
        yield* t.store.reconcile;
        expect((yield* t.folderCredentials)?.claudeAiOauth).toEqual(A.claudeAiOauth);
        expect(yield* t.storeCredentials(B_ID)).toEqual(B);
        expect(yield* t.refreshTokens).toEqual(["rt-a", "rt-b"]);
        expect(yield* t.fileSystem.exists(t.path.join(t.storeDir, "journal.json"))).toBe(false);
      }),
    );

    it.effect("crash after the outgoing copy: the folder's A wins, its store copy goes", () =>
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.fileSystem.makeDirectory(t.path.join(t.storeDir, A_ID), { recursive: true });
        yield* t.write(t.path.join(t.storeDir, A_ID, ".credentials.json"), A);
        yield* t.write(t.path.join(t.storeDir, "journal.json"), journal("outgoing-saved"));
        yield* t.store.reconcile;
        expect((yield* t.folderCredentials)?.claudeAiOauth).toEqual(A.claudeAiOauth);
        expect(yield* t.storeCredentials(A_ID)).toBeUndefined();
        expect(yield* t.storeCredentials(B_ID)).toEqual(B);
        expect(yield* t.refreshTokens).toEqual(["rt-a", "rt-b"]);
      }),
    );

    it.effect("crash after the install: the folder's B wins, A's store copy stays", () =>
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.write(t.path.join(t.folder, ".credentials.json"), { ...B, mcpOAuth: MCP });
        yield* t.fileSystem.makeDirectory(t.path.join(t.storeDir, A_ID), { recursive: true });
        yield* t.write(t.path.join(t.storeDir, A_ID, ".credentials.json"), A);
        yield* t.write(t.path.join(t.storeDir, "journal.json"), journal("installed"));
        yield* t.store.reconcile;
        expect((yield* t.folderCredentials)?.claudeAiOauth).toEqual(B.claudeAiOauth);
        expect(yield* t.storeCredentials(A_ID)).toEqual(A);
        expect(yield* t.storeCredentials(B_ID)).toBeUndefined();
        expect(yield* t.refreshTokens).toEqual(["rt-a", "rt-b"]);
      }),
    );

    it.effect("a folder left without a login gets the journal's target back", () =>
      Effect.gen(function* () {
        const t = yield* setup();
        yield* t.write(t.path.join(t.folder, ".credentials.json"), { mcpOAuth: MCP });
        yield* t.fileSystem.makeDirectory(t.path.join(t.storeDir, A_ID), { recursive: true });
        yield* t.write(t.path.join(t.storeDir, A_ID, ".credentials.json"), A);
        yield* t.write(t.path.join(t.storeDir, "journal.json"), journal("outgoing-saved"));
        yield* t.store.reconcile;
        const folder = yield* t.folderCredentials;
        expect(folder?.claudeAiOauth).toEqual(B.claudeAiOauth);
        expect(folder?.mcpOAuth).toEqual(MCP);
        expect(yield* t.storeCredentials(A_ID)).toEqual(A);
        expect(yield* t.refreshTokens).toEqual(["rt-a", "rt-b"]);
      }),
    );

    it.effect(
      "a rotated copy of the active account in the store is dropped, never the folder's",
      () =>
        Effect.gen(function* () {
          const t = yield* setup();
          yield* t.fileSystem.makeDirectory(t.path.join(t.storeDir, A_ID), { recursive: true });
          yield* t.write(
            t.path.join(t.storeDir, A_ID, ".credentials.json"),
            login("acct-a", "org-a", "rt-a-old"),
          );
          yield* t.store.reconcile;
          expect((yield* t.folderCredentials)?.claudeAiOauth).toEqual(A.claudeAiOauth);
          expect(yield* t.storeCredentials(A_ID)).toBeUndefined();
          expect(yield* t.refreshTokens).toEqual(["rt-a", "rt-b"]);
        }),
    );
  });
});
