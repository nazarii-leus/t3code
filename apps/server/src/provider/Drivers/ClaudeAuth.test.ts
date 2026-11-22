import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type ProviderAuthState,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as NodePtyAdapter from "../../terminal/NodePtyAdapter.ts";
import { makeClaudeAuth } from "./ClaudeAuth.ts";

const owner = "t3-auth-session-owner";

// Behaves like `claude auth login` and `claude mcp login`: opens its link through $BROWSER, waits
// on a 127.0.0.1 callback, and gives up on a callback with a foreign state. Like the real CLI,
// `mcp login` needs a terminal.
const STUB = `
const fs = require("node:fs");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
const [command, action, mcpServer] = process.argv.slice(2);
fs.appendFileSync(process.env.STUB_LOG, process.argv.slice(2).join(" ") + "\\n");
const credentials = process.env.CLAUDE_CONFIG_DIR + "/.credentials.json";
if (action === "logout") {
  if (command === "mcp") fs.writeFileSync(credentials, JSON.stringify({ mcpOAuth: {} }));
  process.exit(0);
}
if (command === "mcp" && !process.stdin.isTTY) process.exit(1);
if (process.env.STUB_FAIL) {
  console.error("Paste code here if prompted > Login failed: account suspended");
  process.exit(1);
}
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.searchParams.get("state") !== "stub-state") {
    response.writeHead(400).end();
    process.exit(1);
  }
  if (command === "mcp") {
    fs.writeFileSync(credentials, JSON.stringify({ mcpOAuth: { [mcpServer + "|1"]: { accessToken: "t" } } }));
  } else {
    fs.writeFileSync(credentials, JSON.stringify({ claudeAiOauth: { accountUuid: "acct", organizationUuid: "org", refreshToken: "rt" } }));
  }
  response.writeHead(302, { location: "https://platform.claude.com/oauth/code/success" });
  response.end(() => process.exit(0));
});
server.listen(0, "127.0.0.1", () => {
  const redirect = encodeURIComponent("http://localhost:" + server.address().port + "/callback");
  execFileSync(process.env.BROWSER, [
    "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=" + redirect + "&state=stub-state",
  ]);
});
`;

const phase = (
  auth: Effect.Success<ReturnType<typeof makeClaudeAuth>>,
  value: ProviderAuthState["phase"],
) =>
  auth.subscribe(owner).pipe(
    Stream.filter((state) => state.phase === value),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const harness = Effect.fn("ClaudeAuth.test.harness")(function* (
  env: Record<string, string> = {},
  extras: (
    directory: string,
  ) => Pick<Parameters<typeof makeClaudeAuth>[0], "accounts" | "mcp" | "folderTaken"> = () => ({}),
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-claude-auth-" });
  const binaryPath = path.join(directory, "claude");
  const log = path.join(directory, "calls.log");
  const configDir = path.join(directory, "home");
  yield* fileSystem.writeFileString(binaryPath, `#!${process.execPath}\n${STUB}`, { mode: 0o755 });
  yield* fileSystem.writeFileString(log, "");
  yield* fileSystem.makeDirectory(configDir);
  yield* fileSystem.writeFileString(
    path.join(configDir, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        jira: { type: "http", url: "https://jira.example.com/mcp" },
        local: { type: "stdio", command: "local-mcp" },
      },
    }),
  );
  let refreshes = 0;
  const auth = yield* makeClaudeAuth({
    instanceId: ProviderInstanceId.make("claude-work"),
    binaryPath,
    environment: { ...process.env, STUB_LOG: log, CLAUDE_CONFIG_DIR: configDir, ...env },
    configDir,
    cwd: directory,
    ...extras(directory),
    // Signed in after a login, signed out after a logout, as the probe would report.
    refresh: fileSystem.readFileString(log).pipe(
      Effect.orDie,
      Effect.map((calls) => {
        refreshes += 1;
        const status = calls.trim().endsWith("logout") ? "unauthenticated" : "authenticated";
        return { auth: { status } } as ServerProvider;
      }),
    ),
  });
  return {
    auth,
    calls: fileSystem.readFileString(log),
    refreshes: () => refreshes,
  };
});

const services = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  NodePtyAdapter.layer.pipe(Layer.provide(NodeServices.layer)),
);

describe("ClaudeAuth", () => {
  // Live clock: a real CLI process and its loopback callback.
  it.live("signs in through Claude's own callback and checks the account", () =>
    Effect.gen(function* () {
      const { auth, calls, refreshes } = yield* harness();
      yield* auth.start(owner);
      const waiting = yield* phase(auth, "waiting");
      const interaction = waiting.interaction;
      assert(interaction?.type === "browser" && interaction.acceptsCallback);
      const port = new URL(new URL(interaction.url).searchParams.get("redirect_uri") ?? "").port;
      const flowId = waiting.flowId ?? "";

      // A foreign state never reaches Claude, which would abandon the sign-in.
      const foreign = yield* Effect.flip(
        auth.complete(owner, {
          flowId,
          callbackUrl: `http://localhost:${port}/callback?code=c&state=other`,
        }),
      );
      assert.include(foreign.detail, "does not belong");

      yield* auth.complete(owner, {
        flowId,
        callbackUrl: `http://localhost:${port}/callback?code=c&state=stub-state`,
      });
      const done = yield* phase(auth, "succeeded");
      assert.strictEqual(done.message, "Sign-in complete.");
      assert.strictEqual(refreshes(), 1);

      yield* auth.logout(Effect.void);
      assert.deepStrictEqual((yield* calls).trim().split("\n"), [
        "auth login --claudeai",
        "auth logout",
      ]);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("shows Claude's reason when sign-in fails", () =>
    Effect.gen(function* () {
      const { auth } = yield* harness({ STUB_FAIL: "1" });
      yield* auth.start(owner);
      const failed = yield* phase(auth, "failed");
      assert.strictEqual(
        failed.message,
        "Claude sign-in did not finish: Login failed: account suspended",
      );
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
  it.live("signs an MCP server in by its key, in that server's folder, then out again", () =>
    Effect.gen(function* () {
      const signedIn: string[] = [];
      const { auth, calls } = yield* harness({}, (directory) => ({
        mcp: {
          signInTarget: (key: string) =>
            key === "user:-:jira" ? { name: "jira", cwd: directory } : undefined,
          afterSignIn: (key: string) => Effect.sync(() => signedIn.push(key)),
        } as unknown as NonNullable<Parameters<typeof makeClaudeAuth>[0]["mcp"]>,
      }));

      yield* auth.start(owner, undefined, "mcp:user:-:jira");
      const waiting = yield* phase(auth, "waiting");
      assert(waiting.interaction?.type === "browser");
      const port = new URL(new URL(waiting.interaction.url).searchParams.get("redirect_uri") ?? "")
        .port;
      yield* auth.complete(owner, {
        flowId: waiting.flowId ?? "",
        callbackUrl: `http://localhost:${port}/callback?code=c&state=stub-state`,
      });
      const done = yield* phase(auth, "succeeded");
      assert.strictEqual(done.methodId, "mcp:user:-:jira");
      assert.strictEqual(done.message, "Signed in to jira.");

      yield* auth.removeMethod!("mcp:user:-:jira");
      assert.deepStrictEqual(signedIn, ["user:-:jira", "user:-:jira"]);
      assert.deepStrictEqual((yield* calls).trim().split("\n"), [
        "mcp login jira",
        "mcp logout jira",
      ]);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  /** An account list whose sign-ins land in a scratch folder the test can see. */
  const scratchAccounts = (
    fileSystem: FileSystem.FileSystem,
    path: Path.Path,
    directory: string,
    seen: { scratch?: string; login?: string; removed?: boolean },
    state: { readonly supported: boolean; readonly activeId: string | null },
  ) =>
    ({
      snapshot: Effect.succeed({ supported: state.supported, accounts: [] }),
      activeId: Effect.succeed(state.activeId),
      newScratchDir: Effect.gen(function* () {
        const scratch = path.join(directory, "scratch");
        yield* fileSystem.makeDirectory(scratch).pipe(Effect.orDie);
        seen.scratch = scratch;
        return scratch;
      }),
      adoptSignIn: (scratch: string) =>
        fileSystem.readFileString(path.join(scratch, ".credentials.json")).pipe(
          Effect.orDie,
          Effect.map((text) => {
            seen.login = text;
            return "Added Max 20x.";
          }),
        ),
      removeScratchDir: () => Effect.sync(() => (seen.removed = true)),
    }) as unknown as NonNullable<Parameters<typeof makeClaudeAuth>[0]["accounts"]>;

  const signInThroughBrowser = Effect.fn("signInThroughBrowser")(function* (
    auth: Effect.Success<ReturnType<typeof harness>>["auth"],
    methodId: string | undefined,
  ) {
    yield* auth.start(owner, undefined, methodId);
    const waiting = yield* phase(auth, "waiting");
    assert(waiting.interaction?.type === "browser");
    const port = new URL(new URL(waiting.interaction.url).searchParams.get("redirect_uri") ?? "")
      .port;
    yield* auth.complete(owner, {
      flowId: waiting.flowId ?? "",
      callbackUrl: `http://localhost:${port}/callback?code=c&state=stub-state`,
    });
    return yield* phase(auth, "succeeded");
  });

  it.live("adds an account by signing in inside a scratch folder", () =>
    Effect.gen(function* () {
      const seen: { scratch?: string; login?: string; removed?: boolean } = {};
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { auth, calls } = yield* harness({}, (directory) => ({
        accounts: scratchAccounts(fileSystem, path, directory, seen, {
          supported: true,
          activeId: null,
        }),
      }));
      const done = yield* signInThroughBrowser(auth, "account:add");
      assert.strictEqual(done.message, "Added Max 20x.");
      assert.include(seen.login ?? "", "acct");
      assert.isTrue(seen.removed);
      assert.deepStrictEqual((yield* calls).trim().split("\n"), ["auth login --claudeai"]);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("a plain sign-in beside an account in use adds it, keeping the active login", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const seen: { scratch?: string; login?: string; removed?: boolean } = {};
      const { auth } = yield* harness({}, (directory) => ({
        accounts: scratchAccounts(fileSystem, path, directory, seen, {
          supported: true,
          activeId: "acct-a.org-a",
        }),
      }));
      const done = yield* signInThroughBrowser(auth, undefined);
      assert.strictEqual(done.message, "Added Max 20x.");
      assert.isDefined(seen.scratch);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("where accounts can't switch, adding one is the plain sign-in", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const seen: { scratch?: string; login?: string; removed?: boolean } = {};
      const { auth } = yield* harness({}, (directory) => ({
        accounts: scratchAccounts(fileSystem, path, directory, seen, {
          supported: false,
          activeId: null,
        }),
      }));
      yield* signInThroughBrowser(auth, "account:add");
      assert.isUndefined(seen.scratch);
    }).pipe(Effect.scoped, Effect.provide(services)),
  );

  it.live("refuses sign-ins for a folder another provider owns, and unknown account ids", () =>
    Effect.gen(function* () {
      const taken = yield* harness({}, () => ({ folderTaken: true }));
      yield* taken.auth.start(owner, undefined, undefined);
      assert.include(
        (yield* phase(taken.auth, "failed")).message ?? "",
        "Another Claude provider already uses this folder",
      );
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const seen = {};
      const { auth } = yield* harness({}, (directory) => ({
        accounts: scratchAccounts(fileSystem, path, directory, seen, {
          supported: true,
          activeId: null,
        }),
      }));
      yield* auth.start(owner, undefined, "account:renew:");
      assert.include((yield* phase(auth, "failed")).message ?? "", "Choose the account");
    }).pipe(Effect.scoped, Effect.provide(services)),
  );
});
