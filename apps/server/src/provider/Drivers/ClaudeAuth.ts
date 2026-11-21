// @effect-diagnostics nodeBuiltinImport:off - node:http hands the pasted callback to Claude's loopback listener with no proxy or redirects.
import * as NodeHttp from "node:http";

import {
  isProviderAccountMethodId,
  PROVIDER_ACCOUNT_ADD_METHOD_ID,
  PROVIDER_ACCOUNT_RENEW_METHOD_PREFIX,
  PROVIDER_MCP_METHOD_PREFIX,
  ProviderSetupError,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import type { ClaudeAccounts } from "../claudeAccounts/ClaudeAccounts.ts";
import type { ClaudeMcpManager } from "../claudeMcp/ClaudeMcpManager.ts";
import { collectStreamAsString } from "@t3tools/provider-core/server/snapshotProbe";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

interface PendingCallback {
  readonly port: string;
  readonly state: string;
}

/** Claude opens a loopback callback page; the browser lands there once the user signs in. */
function parseClaudeSignInUrl(url: string): PendingCallback | undefined {
  const authorize = URL.parse(url);
  const redirect = URL.parse(authorize?.searchParams.get("redirect_uri") ?? "");
  const state = authorize?.searchParams.get("state");
  if (
    (authorize?.protocol !== "https:" && authorize?.protocol !== "http:") ||
    redirect?.protocol !== "http:" ||
    (redirect.hostname !== "localhost" && redirect.hostname !== "127.0.0.1") ||
    !redirect.port ||
    !state
  ) {
    return undefined;
  }
  return { port: redirect.port, state };
}

/** Claude abandons the whole sign-in on a callback with a foreign state, so check it first. */
function claudeCallbackPath(pending: PendingCallback, callbackUrl: string) {
  const callback = URL.parse(callbackUrl.trim());
  if (
    callback?.protocol !== "http:" ||
    (callback.hostname !== "localhost" && callback.hostname !== "127.0.0.1") ||
    callback.port !== pending.port ||
    callback.pathname !== "/callback" ||
    callback.searchParams.getAll("state").join() !== pending.state ||
    callback.searchParams.getAll("code").length + callback.searchParams.getAll("error").length !== 1
  ) {
    return undefined;
  }
  return `${callback.pathname}${callback.search}`;
}

// Claude listens on 127.0.0.1 even though its redirect URI says localhost.
const deliverCallback = (instanceId: ProviderInstanceId, port: string, requestPath: string) =>
  Effect.callback<void, ProviderSetupError>((resume) => {
    const request = NodeHttp.request(
      { hostname: "127.0.0.1", port, path: requestPath, method: "GET", agent: false },
      (response) => {
        response.resume();
        resume(Effect.void);
      },
    );
    request.once("error", () =>
      resume(
        Effect.fail(
          new ProviderSetupError({
            instanceId,
            operation: "complete",
            detail: "Could not deliver the sign-in response. Start sign-in again.",
          }),
        ),
      ),
    );
    request.end();
    return Effect.sync(() => request.destroy());
  }).pipe(
    // Claude may answer only after exchanging the code; its exit decides the sign-in either way.
    Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.void }),
  );

const lastMessage = (output: string) =>
  output
    .split(/\r?\n/)
    .map((line) => line.replace(/^.*>\s*/, "").trim())
    .filter((line) => line.length > 0 && !line.includes("://"))
    .at(-1);

const ACCOUNT_METHOD = {
  id: "claudeai",
  name: "Claude account",
  description: null,
  type: "agent" as const,
};
const MCP_METHOD_PREFIX = PROVIDER_MCP_METHOD_PREFIX;
// Terminal colours and links in Claude's output.
const TERMINAL_ESCAPES = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;

interface SignInProcess {
  readonly exitCode: Effect.Effect<number>;
  /** What the process printed, complete once it has exited. */
  readonly output: Effect.Effect<string>;
}

export const makeClaudeAuth = Effect.fn("ClaudeAuth.make")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  /** The account's environment, with its CLAUDE_CONFIG_DIR. */
  readonly environment: NodeJS.ProcessEnv;
  readonly configDir: string;
  readonly cwd: string;
  /** Present where accounts switch in one folder; adds the account sign-in methods. */
  readonly accounts?: ClaudeAccounts;
  /** MCP sign-ins by server key (`mcp:<key>`). */
  readonly mcp?: ClaudeMcpManager;
  readonly refresh: Effect.Effect<ServerProvider>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const failure = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });

  const spawnProcess = Effect.fnUntraced(function* (
    args: ReadonlyArray<string>,
    environment: NodeJS.ProcessEnv,
    cwd: string = options.cwd,
  ) {
    const command = yield* resolveSpawnCommand(options.binaryPath, args, { env: environment });
    const child = yield* spawner.spawn(
      ChildProcess.make(command.command, command.args, {
        env: environment,
        shell: command.shell,
        cwd,
      }),
    );
    const output = yield* Effect.all(
      [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr)],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((streams) => streams.join("\n")),
      Effect.forkScoped,
    );
    return {
      exitCode: child.exitCode.pipe(
        Effect.map(Number),
        Effect.orElseSucceed(() => -1),
      ),
      output: Fiber.join(output).pipe(Effect.orElseSucceed(() => "")),
    } satisfies SignInProcess;
  });

  // `claude mcp login` refuses to run without a terminal.
  const spawnTerminal = Effect.fnUntraced(function* (
    args: ReadonlyArray<string>,
    environment: NodeJS.ProcessEnv,
    cwd: string = options.cwd,
  ) {
    if (Option.isNone(pty)) {
      return yield* failure("start", "Interactive sign-in is unavailable on this environment.");
    }
    const exited = yield* Deferred.make<number>();
    let output = "";
    const terminal = yield* pty.value
      .spawn({
        shell: options.binaryPath,
        args: [...args],
        cwd,
        cols: 120,
        rows: 30,
        env: environment,
      })
      .pipe(Effect.mapError(() => failure("start", "Could not open a terminal for the sign-in.")));
    const detachData = terminal.onData((data) => {
      output = (output + data).slice(-16_384);
    });
    const detachExit = terminal.onExit(({ exitCode }) => {
      Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        detachData();
        detachExit();
        try {
          terminal.kill();
        } catch {}
      }),
    );
    return {
      exitCode: Deferred.await(exited),
      output: Effect.sync(() => output.replace(TERMINAL_ESCAPES, "")),
    } satisfies SignInProcess;
  });

  // Claude opens its sign-in page through $BROWSER; this one hands the URL to T3 Code instead.
  const signInThroughBrowser = Effect.fnUntraced(function* (
    context: ProviderAuthFlow.ProviderAuthFlowContext,
    start: (
      environment: NodeJS.ProcessEnv,
    ) => Effect.Effect<SignInProcess, ProviderSetupError | PlatformError, Scope.Scope>,
  ) {
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-signin-" });
    const urlFile = path.join(directory, "url");
    const browser = path.join(directory, "browser");
    yield* fileSystem.writeFileString(
      browser,
      `#!/bin/sh\nprintf '%s\\n' "$1" > '${urlFile.replaceAll("'", "'\\''")}'\n`,
      { mode: 0o700 },
    );
    const signIn = yield* start({ ...options.environment, BROWSER: browser });
    const failed = (code: number) =>
      signIn.output.pipe(
        Effect.flatMap((text) => {
          const reason = lastMessage(text);
          return Effect.fail(
            failure(
              "start",
              reason
                ? `Claude sign-in did not finish: ${reason}`
                : `Claude sign-in did not finish (exit code ${code}). Start again.`,
            ),
          );
        }),
      );
    const notOpened = failure("start", "Claude did not open its sign-in page. Start again.");
    const url = yield* fileSystem.readFileString(urlFile).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")),
      Effect.map((text) => text.trim()),
      Effect.filterOrFail(
        (text) => text.length > 0,
        () => notOpened,
      ),
      Effect.retry({
        schedule: Schedule.spaced("200 millis"),
        while: (error) => error === notOpened,
      }),
      Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.fail(notOpened) }),
      Effect.raceFirst(signIn.exitCode.pipe(Effect.flatMap(failed))),
    );
    const pending = parseClaudeSignInUrl(url);
    if (!pending) return yield* failure("start", "Claude opened an unexpected sign-in page.");
    yield* context.setInteraction(
      {
        type: "browser",
        id: "claude-signin",
        url,
        requiresConsent: false,
        acceptsCallback: true,
      },
      undefined,
      (callbackUrl) => {
        const requestPath = claudeCallbackPath(pending, callbackUrl);
        return requestPath === undefined
          ? Effect.fail(
              failure("complete", "This address does not belong to the current Claude sign-in."),
            )
          : deliverCallback(options.instanceId, pending.port, requestPath);
      },
    );
    const code = yield* signIn.exitCode;
    if (code !== 0) return yield* failed(code);
  });

  // Account sign-ins run in a scratch folder and never touch running sessions, so they are
  // connections to the flow; the accounts service then stores or installs the login.
  const accounts = options.accounts;
  const signInAccount = Effect.fnUntraced(function* (
    context: ProviderAuthFlow.ProviderAuthFlowContext,
    expectedId: string | null,
  ) {
    if (!accounts) return yield* failure("start", "Accounts are not available here.");
    const email =
      expectedId === null
        ? undefined
        : (yield* accounts.snapshot).accounts.find((account) => account.id === expectedId)?.email;
    const scratch = yield* accounts.newScratchDir.pipe(
      Effect.mapError(() => failure("start", "Could not prepare the sign-in folder.")),
    );
    return yield* Effect.gen(function* () {
      yield* signInThroughBrowser(context, (environment) =>
        spawnProcess(["auth", "login", "--claudeai", ...(email ? ["--email", email] : [])], {
          ...environment,
          CLAUDE_CONFIG_DIR: scratch,
        }),
      );
      yield* context.verifying;
      return yield* accounts
        .adoptSignIn(scratch, expectedId)
        .pipe(Effect.mapError((error) => failure("start", error.detail)));
    }).pipe(Effect.ensuring(accounts.removeScratchDir(scratch)));
  });

  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: `claude:${options.configDir}` },
    methods: Effect.succeed([ACCOUNT_METHOD]),
    defaultMethodId: ACCOUNT_METHOD.id,
    refreshMethodsAfterAuth: true,
    resolveMethod: (methodId) => {
      if (accounts && isProviderAccountMethodId(methodId)) {
        return { id: methodId, name: "Claude account", description: null, type: "connection" };
      }
      const target = methodId.startsWith(MCP_METHOD_PREFIX)
        ? options.mcp?.signInTarget(methodId.slice(MCP_METHOD_PREFIX.length))
        : undefined;
      return target
        ? {
            id: methodId,
            name: target.name,
            description: null,
            type: "connection",
            canRemove: true,
          }
        : undefined;
    },
    authenticate: Effect.fn("ClaudeAuth.authenticate")(
      function* (methodId, context) {
        if (methodId === PROVIDER_ACCOUNT_ADD_METHOD_ID) return yield* signInAccount(context, null);
        if (methodId.startsWith(PROVIDER_ACCOUNT_RENEW_METHOD_PREFIX)) {
          return yield* signInAccount(
            context,
            methodId.slice(PROVIDER_ACCOUNT_RENEW_METHOD_PREFIX.length),
          );
        }
        if (methodId.startsWith(MCP_METHOD_PREFIX)) {
          const key = methodId.slice(MCP_METHOD_PREFIX.length);
          const target = options.mcp?.signInTarget(key);
          if (!target) return yield* failure("start", "This MCP server is no longer listed.");
          yield* signInThroughBrowser(context, (environment) =>
            spawnTerminal(["mcp", "login", target.name], environment, target.cwd),
          );
          yield* options.mcp!.afterSignIn(key);
          return `Signed in to ${target.name}.`;
        }
        yield* signInThroughBrowser(context, (environment) =>
          spawnProcess(["auth", "login", "--claudeai"], environment),
        );
        yield* context.verifying;
        const provider = yield* options.refresh;
        if (provider.auth.status !== "authenticated") {
          return yield* failure(
            "start",
            provider.message
              ? `Claude signed in, but its status check failed: ${provider.message}`
              : "Claude did not report a signed-in account. Try again.",
          );
        }
      },
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.logWarning("Could not run Claude sign-in.", { cause }).pipe(
            Effect.andThen(
              Effect.fail(failure("start", "Could not start Claude sign-in. Try again.")),
            ),
          ),
      }),
    ),
    // Removing a connection signs this account out of that MCP server.
    removeMethod: Effect.fn("ClaudeAuth.removeMethod")(
      function* (methodId: string) {
        const key = methodId.startsWith(MCP_METHOD_PREFIX)
          ? methodId.slice(MCP_METHOD_PREFIX.length)
          : undefined;
        const target = key === undefined ? undefined : options.mcp?.signInTarget(key);
        if (key === undefined || !target) {
          return yield* failure("removeMethod", "Only MCP server sign-ins can be removed.");
        }
        const signOut = yield* spawnProcess(
          ["mcp", "logout", target.name],
          options.environment,
          target.cwd,
        );
        if ((yield* signOut.exitCode) !== 0) {
          return yield* failure("removeMethod", "Claude could not sign out of this MCP server.");
        }
        yield* options.mcp!.afterSignIn(key);
      },
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: "1 minute",
        orElse: () =>
          Effect.fail(failure("removeMethod", "Claude did not finish signing out. Try again.")),
      }),
      Effect.catchTags({
        PlatformError: () =>
          Effect.fail(failure("removeMethod", "Claude could not sign out of this MCP server.")),
      }),
    ),
    logout: Effect.gen(function* () {
      const signOut = yield* spawnProcess(["auth", "logout"], options.environment);
      const code = yield* signOut.exitCode;
      const provider = yield* options.refresh;
      if (code !== 0 || provider.auth.status === "authenticated") {
        return yield* failure("logout", "Claude could not sign out. Try again.");
      }
    }).pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: "1 minute",
        orElse: () =>
          Effect.fail(failure("logout", "Claude did not finish signing out. Try again.")),
      }),
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.logWarning("Could not run Claude sign-out.", { cause }).pipe(
            Effect.andThen(Effect.fail(failure("logout", "Claude could not sign out. Try again."))),
          ),
      }),
    ),
  });
});
