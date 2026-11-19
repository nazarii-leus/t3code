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

import { makeClaudeAuth } from "./ClaudeAuth.ts";

const owner = "t3-auth-session-owner";

// Behaves like `claude auth login`: opens its link through $BROWSER, waits on a 127.0.0.1
// callback, and gives up on a callback with a foreign state.
const STUB = `
const fs = require("node:fs");
const http = require("node:http");
const { execFileSync } = require("node:child_process");
fs.appendFileSync(process.env.STUB_LOG, process.argv.slice(2).join(" ") + "\\n");
if (process.argv[3] === "logout") process.exit(0);
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

const harness = Effect.fn("ClaudeAuth.test.harness")(function* (env: Record<string, string> = {}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-claude-auth-" });
  const binaryPath = path.join(directory, "claude");
  const log = path.join(directory, "calls.log");
  yield* fileSystem.writeFileString(binaryPath, `#!${process.execPath}\n${STUB}`, { mode: 0o755 });
  yield* fileSystem.writeFileString(log, "");
  let refreshes = 0;
  const auth = yield* makeClaudeAuth({
    instanceId: ProviderInstanceId.make("claude-work"),
    binaryPath,
    environment: { ...process.env, STUB_LOG: log, ...env },
    configDir: path.join(directory, "home"),
    cwd: directory,
    accountEmail: "work@example.com",
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

const services = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

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
        "auth login --claudeai --email work@example.com",
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
});
