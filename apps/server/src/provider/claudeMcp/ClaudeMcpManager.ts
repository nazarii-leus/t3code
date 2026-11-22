// @effect-diagnostics nodeBuiltinImport:off - `claude mcp add-json -` reads its JSON from stdin.
import * as NodeChildProcess from "node:child_process";
import * as NodeTimersPromises from "node:timers/promises";

import {
  ProviderMcpError,
  providerMcpServerKey,
  type ProviderInstanceId,
  type ProviderMcpScope,
  type ProviderMcpServer,
  type ProviderMcpServerConfigView,
  type ProviderMcpServerInput,
  type ProviderMcpSnapshot,
} from "@t3tools/contracts";
import type {
  ProviderMcpController,
  ProviderMcpProject,
} from "@t3tools/provider-core/server/driver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ClaudeMcpQuery, ClaudeMcpQueryError } from "../ClaudeProvider.ts";
import { liveClaudeQueryKey, reconnectLiveClaudeQueries } from "./liveClaudeQueries.ts";

type Json = Record<string, unknown>;
const asRecord = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const asStrings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const TOKEN_FLAG =
  /^--?(token|api[-_]?key|key|secret|password|auth|authorization|bearer|header)(=.*)?$/i;
const LONG_SECRET = /^[A-Za-z0-9+/_=.-]{24,}$/;
const SECRET_TEXT = /bearer\s+\S|authorization\s*:|api[-_]?key\s*[:=]/i;
const MASK = "••••";
const decodeJsonText = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Scheme, host and path, without query or userinfo; a token-like path segment is masked. */
function redactMcpUrl(url: string): string {
  const parsed = URL.parse(url);
  if (!parsed) return "";
  const pathname = parsed.pathname
    .split("/")
    .map((segment) => (LONG_SECRET.test(segment) ? MASK : segment))
    .join("/");
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

/** A command line with every secret-looking argument masked, index for index. */
function redactMcpArgs(parts: ReadonlyArray<string>): string[] {
  let maskNext = false;
  return parts.map((part) => {
    if (maskNext) {
      maskNext = false;
      return MASK;
    }
    const flag = TOKEN_FLAG.exec(part);
    if (flag) {
      if (flag[2]) return `${part.slice(0, part.indexOf("="))}=${MASK}`;
      maskNext = true;
      return part;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(part)) return redactMcpUrl(part) || MASK;
    if (/^[A-Z0-9_]+=.+/.test(part)) return `${part.slice(0, part.indexOf("="))}=${MASK}`;
    if (SECRET_TEXT.test(part)) return MASK;
    return LONG_SECRET.test(part) ? MASK : part;
  });
}

/** What clients see of a server's address. Never a secret. */
export function redactMcpTarget(config: Json): string {
  const url = typeof config.url === "string" ? config.url : undefined;
  if (url) return redactMcpUrl(url);
  return redactMcpArgs(
    [typeof config.command === "string" ? config.command : "", ...asStrings(config.args)].filter(
      (part) => part.length > 0,
    ),
  ).join(" ");
}

const transportOf = (config: Json): ProviderMcpServer["transport"] => {
  const type = typeof config.type === "string" ? config.type : config.command ? "stdio" : "";
  return type === "http" || type === "sse" || type === "stdio" || type === "ws" ? type : "other";
};

const scopeOf = (scope: unknown, source: unknown): ProviderMcpScope => {
  const value = String(source ?? scope ?? "");
  if (value === "plugin") return "plugin";
  if (value === "claudeai" || scope === "claudeai") return "claudeai";
  if (value === "managed" || value === "enterprise") return "managed";
  if (scope === "user" || scope === "local" || scope === "project") return scope;
  return "other";
};

export interface ClaudeMcpManagerOptions {
  readonly instanceId: ProviderInstanceId;
  /** The Claude folder (its `.credentials.json` holds the MCP sign-ins). */
  readonly folder: string;
  /** `.claude.json` of the folder: user and local servers, per-project off switches. */
  readonly profileFile: string;
  /** An empty folder to run checks in when no project is picked. */
  readonly neutralCwd: string;
  readonly binaryPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly query: <A>(input: {
    readonly cwd: string;
    readonly only?: { readonly name: string; readonly config: Json };
    readonly use: (query: ClaudeMcpQuery) => Promise<A>;
  }) => Effect.Effect<A, ClaudeMcpQueryError>;
  readonly activeAccountName: Effect.Effect<string | null>;
}

export const makeClaudeMcpManager = Effect.fn("ClaudeMcpManager.make")(function* (
  options: ClaudeMcpManagerOptions,
): Effect.fn.Return<ClaudeMcpManager, never, FileSystem.FileSystem | Path.Path | Scope.Scope> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const scope = yield* Scope.Scope;
  const failure = (operation: string, detail: string) =>
    new ProviderMcpError({ instanceId: options.instanceId, operation, detail });
  const snapshots = new Map<string, SubscriptionRef.SubscriptionRef<ProviderMcpSnapshot>>();
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const readJson = (file: string) =>
    fileSystem.readFileString(file).pipe(
      Effect.map((raw) => asRecord(JSON.parse(raw))),
      Effect.orElseSucceed(() => ({}) as Json),
    );

  interface Configured {
    readonly scope: "user" | "local" | "project";
    readonly name: string;
    readonly config: Json;
  }

  /** The OAuth client secret Claude keeps for a server; it never leaves the server. */
  const storedClientSecret = Effect.fn("ClaudeMcpManager.storedClientSecret")(function* (
    name: string,
  ) {
    // An unreadable file is an error, not "no secret": an edit would otherwise lose the secret.
    const file = path.join(options.folder, ".credentials.json");
    const text = yield* fileSystem.readFileString(file).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("{}")),
      Effect.mapError(() =>
        failure("save", "Couldn't read Claude's sign-ins, so the server was not changed."),
      ),
    );
    const credentials = asRecord(
      yield* decodeJsonText(text).pipe(
        Effect.mapError(() =>
          failure("save", "Claude's sign-ins file is not JSON, so the server was not changed."),
        ),
      ),
    );
    for (const [entryKey, entry] of Object.entries(asRecord(credentials.mcpOAuthClientConfig))) {
      const secret = asRecord(entry).clientSecret;
      if (entryKey.split("|")[0] === name && typeof secret === "string" && secret) return secret;
    }
    return undefined;
  });

  const configured = Effect.fn("ClaudeMcpManager.configured")(function* (
    project: ProviderMcpProject | null,
  ) {
    const profile = yield* readJson(options.profileFile);
    const list: Configured[] = Object.entries(asRecord(profile.mcpServers)).map(
      ([name, config]) => ({
        scope: "user" as const,
        name,
        config: asRecord(config),
      }),
    );
    if (project) {
      const local = asRecord(asRecord(asRecord(profile.projects)[project.root]).mcpServers);
      for (const [name, config] of Object.entries(local))
        list.push({ scope: "local", name, config: asRecord(config) });
      const shared = asRecord((yield* readJson(path.join(project.root, ".mcp.json"))).mcpServers);
      for (const [name, config] of Object.entries(shared))
        list.push({ scope: "project", name, config: asRecord(config) });
    }
    const disabled = project
      ? new Set(asStrings(asRecord(asRecord(profile.projects)[project.root]).disabledMcpServers))
      : new Set<string>();
    const credentials = yield* readJson(path.join(options.folder, ".credentials.json"));
    const signedIn = new Set(
      Object.entries(asRecord(credentials.mcpOAuth))
        .filter(([, entry]) => asRecord(entry).accessToken || asRecord(entry).refreshToken)
        .map(([key]) => key.split("|")[0]),
    );
    return { list, disabled, signedIn };
  });

  const toServer = (
    project: ProviderMcpProject | null,
    scope: ProviderMcpScope,
    name: string,
    config: Json,
    signedIn: boolean | null,
    state: ProviderMcpServer["state"],
    extra: Partial<ProviderMcpServer> = {},
  ): ProviderMcpServer => {
    const writable = scope === "user" || scope === "local" || scope === "project";
    const transport = transportOf(config);
    return {
      key: providerMcpServerKey(
        scope,
        scope === "local" || scope === "project" ? (project?.id ?? null) : null,
        name,
      ),
      name,
      scope,
      scopeDetail: null,
      transport,
      target: redactMcpTarget(config),
      headerNames: Object.keys(asRecord(config.headers)),
      envNames: Object.keys(asRecord(config.env)),
      state,
      checking: false,
      error: null,
      tools: null,
      signedIn,
      canEdit: writable,
      canRemove: writable,
      canToggle: project !== null,
      canSignIn: transport === "http" || transport === "sse" || scope === "claudeai",
      ...extra,
    };
  };

  /** Projects seen by this manager, so a sign-in of a project server can run in its folder. */
  const projectRoots = new Map<string, string>();
  const refOf = Effect.fn(function* (project: ProviderMcpProject | null) {
    const key = project?.id ?? "-";
    if (project) projectRoots.set(project.id, project.root);
    const existing = snapshots.get(key);
    if (existing) return existing;
    const ref = yield* SubscriptionRef.make<ProviderMcpSnapshot>({
      projectId: (project?.id ?? null) as ProviderMcpSnapshot["projectId"],
      projectName: project?.name ?? null,
      checkedAt: null,
      checking: false,
      error: null,
      servers: [],
    });
    snapshots.set(key, ref);
    yield* reloadConfigured(project, ref);
    return ref;
  });

  /** Merges the files into the list; servers a check found keep their live state. */
  const reloadConfigured = Effect.fn("ClaudeMcpManager.reloadConfigured")(function* (
    project: ProviderMcpProject | null,
    ref: SubscriptionRef.SubscriptionRef<ProviderMcpSnapshot>,
  ) {
    const { list, disabled, signedIn } = yield* configured(project);
    const current = yield* SubscriptionRef.get(ref);
    const byKey = new Map(current.servers.map((server) => [server.key, server]));
    const fromFiles = list.map((entry) => {
      const fresh = toServer(
        project,
        entry.scope,
        entry.name,
        entry.config,
        signedIn.has(entry.name),
        disabled.has(entry.name) ? "disabled" : "unknown",
      );
      const known = byKey.get(fresh.key);
      return known
        ? { ...fresh, state: known.state, error: known.error, tools: known.tools }
        : fresh;
    });
    const fileKeys = new Set(fromFiles.map((server) => server.key));
    // Plugin, claude.ai and managed servers come only from a check; keep them between checks.
    const others = current.servers.filter(
      (server) => !fileKeys.has(server.key) && !["user", "local", "project"].includes(server.scope),
    );
    yield* SubscriptionRef.set(ref, { ...current, servers: [...fromFiles, ...others] });
  });

  const statusToServer = (
    project: ProviderMcpProject | null,
    status: Awaited<ReturnType<ClaudeMcpQuery["mcpServerStatus"]>>[number],
    signedIn: ReadonlySet<string | undefined>,
    activeName: string | null,
  ): ProviderMcpServer => {
    const scope = scopeOf(status.scope, status.source);
    const config = asRecord(status.config);
    const state: ProviderMcpServer["state"] =
      status.status === "connected"
        ? "connected"
        : status.status === "needs-auth"
          ? "needs-auth"
          : status.status === "failed"
            ? "failed"
            : status.status === "disabled"
              ? "disabled"
              : "unknown";
    return toServer(
      project,
      scope,
      status.name,
      config,
      scope === "claudeai" ? null : signedIn.has(status.name),
      state,
      {
        scopeDetail:
          scope === "claudeai"
            ? activeName
            : scope === "plugin"
              ? String(status.source ?? "") || null
              : null,
        error: status.error ?? null,
        tools: status.tools
          ? status.tools.map((tool) => ({
              name: tool.name,
              readOnly: tool.annotations?.readOnly === true,
              destructive: tool.annotations?.destructive === true,
            }))
          : null,
      },
    );
  };

  /** A check that is cut short (the client left) clears its spinners. */
  const runCheck = (project: ProviderMcpProject | null, key: string | null) =>
    runCheckNow(project, key).pipe(
      Effect.onInterrupt(() =>
        refOf(project).pipe(
          Effect.flatMap((ref) =>
            SubscriptionRef.update(ref, (snapshot) => ({
              ...snapshot,
              checking: false,
              servers: snapshot.servers.map((server) => ({ ...server, checking: false })),
            })),
          ),
        ),
      ),
    );
  const runCheckNow = Effect.fn("ClaudeMcpManager.runCheck")(function* (
    project: ProviderMcpProject | null,
    key: string | null,
  ) {
    const ref = yield* refOf(project);
    const before = yield* SubscriptionRef.get(ref);
    const target = key === null ? undefined : before.servers.find((server) => server.key === key);
    yield* SubscriptionRef.set(ref, {
      ...before,
      checking: key === null,
      servers: before.servers.map((server) =>
        key === null || server.key === key ? { ...server, checking: true } : server,
      ),
    });
    const { list, signedIn } = yield* configured(project);
    const only = target
      ? list.find((entry) => entry.name === target.name && entry.scope === target.scope)
      : undefined;
    const statuses = yield* options
      .query({
        cwd: project?.root ?? options.neutralCwd,
        ...(only ? { only: { name: only.name, config: only.config } } : {}),
        use: async (q) => {
          for (let attempt = 0; ; attempt++) {
            const list = await q.mcpServerStatus();
            if (attempt >= 20 || !list.some((server) => server.status === "pending")) return list;
            await NodeTimersPromises.setTimeout(1000);
          }
        },
      })
      .pipe(Effect.result);
    const activeName = yield* options.activeAccountName;
    const checkedAt = yield* nowIso;
    const after = yield* SubscriptionRef.get(ref);
    if (statuses._tag === "Failure") {
      yield* SubscriptionRef.set(ref, {
        ...after,
        checking: false,
        error: key === null ? "Couldn't check the servers. Try again." : after.error,
        servers: after.servers.map((server) => ({ ...server, checking: false })),
      });
      return;
    }
    const checked = statuses.success.map((status) =>
      statusToServer(project, status, signedIn, activeName),
    );
    const checkedKeys = new Set(checked.map((server) => server.key));
    const kept =
      key === null
        ? after.servers.filter(
            (server) =>
              !checkedKeys.has(server.key) && ["user", "local", "project"].includes(server.scope),
          )
        : after.servers.filter((server) => !checkedKeys.has(server.key));
    const merged = key === null ? [...checked, ...kept] : [...kept, ...checked];
    // Keep the files' order for writable servers, checks' order for the rest.
    yield* SubscriptionRef.set(ref, {
      ...after,
      checkedAt: key === null ? checkedAt : after.checkedAt,
      checking: false,
      error: key === null ? null : after.error,
      servers: merged.map((server) => ({ ...server, checking: false })),
    });
    yield* reloadConfigured(project, ref);
  });

  const claudeEnv = () => options.environment;

  const runCli = Effect.fn("ClaudeMcpManager.runCli")(
    function* (args: ReadonlyArray<string>, cwd: string, stdin?: string, extraEnv: Json = {}) {
      const env = { ...claudeEnv(), ...(extraEnv as NodeJS.ProcessEnv) };
      const command = yield* resolveSpawnCommand(options.binaryPath, args, { env });
      return yield* Effect.callback<{ code: number; output: string }>((resume) => {
        const child = NodeChildProcess.spawn(command.command, [...command.args], {
          cwd,
          env,
          shell: command.shell,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let output = "";
        child.stdout?.on("data", (chunk) => (output = (output + String(chunk)).slice(-4_000)));
        child.stderr?.on("data", (chunk) => (output = (output + String(chunk)).slice(-4_000)));
        child.on("error", (error) =>
          resume(Effect.succeed({ code: -1, output: output || error.message })),
        );
        child.on("close", (code) => resume(Effect.succeed({ code: code ?? -1, output })));
        // A child that exits before reading stdin makes the pipe fail; the exit code reports it.
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(stdin ?? "");
        return Effect.sync(() => child.kill());
      });
    },
    (effect) =>
      effect.pipe(
        Effect.timeoutOrElse({
          duration: "1 minute",
          orElse: () => Effect.succeed({ code: -1, output: "timed out" }),
        }),
      ),
  );

  const lastLine = (output: string) =>
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? "";

  const findConfigured = Effect.fn("ClaudeMcpManager.findConfigured")(function* (
    project: ProviderMcpProject | null,
    key: string,
  ) {
    const { list } = yield* configured(project);
    const entry = list.find(
      (candidate) =>
        providerMcpServerKey(
          candidate.scope,
          candidate.scope === "user" ? null : (project?.id ?? null),
          candidate.name,
        ) === key,
    );
    if (!entry) return yield* failure("find", "This server is no longer configured.");
    return entry;
  });

  const cwdFor = (project: ProviderMcpProject | null, scope: string) =>
    scope === "user" ? options.neutralCwd : (project?.root ?? options.neutralCwd);

  const subscribe = (project: ProviderMcpProject | null) =>
    Stream.unwrap(
      refOf(project).pipe(
        Effect.tap((ref) => reloadConfigured(project, ref)),
        Effect.map((ref) => SubscriptionRef.changes(ref)),
      ),
    );

  const check = (project: ProviderMcpProject | null, key: string | null) =>
    lock
      .withPermits(1)(runCheck(project, key))
      .pipe(Effect.andThen(refOf(project)), Effect.flatMap(SubscriptionRef.get));

  const get = Effect.fn("ClaudeMcpManager.get")(function* (
    project: ProviderMcpProject | null,
    key: string,
  ) {
    const entry = yield* findConfigured(project, key);
    const config = entry.config;
    const oauth = asRecord(config.oauth);
    return {
      key,
      scope: entry.scope,
      name: entry.name,
      transport: (["http", "sse"].includes(String(config.type)) ? config.type : "stdio") as
        | "http"
        | "sse"
        | "stdio",
      // Secrets in the address or the arguments stay masked; a save keeps the stored values.
      url: typeof config.url === "string" ? redactMcpUrl(config.url) : null,
      headerNames: Object.keys(asRecord(config.headers)),
      command: typeof config.command === "string" ? config.command : null,
      args: redactMcpArgs(asStrings(config.args)),
      envNames: Object.keys(asRecord(config.env)),
      oauthClientId: typeof oauth.clientId === "string" ? oauth.clientId : null,
      oauthHasClientSecret:
        (yield* storedClientSecret(entry.name).pipe(Effect.orElseSucceed(() => undefined))) !==
        undefined,
      oauthCallbackPort: typeof oauth.callbackPort === "number" ? oauth.callbackPort : null,
    } satisfies ProviderMcpServerConfigView;
  });

  const buildConfig = (input: ProviderMcpServerInput, previous: Json | undefined) => {
    const keep = (kind: "headers" | "env", name: string) => asRecord(previous?.[kind])[name];
    const pairs = (
      kind: "headers" | "env",
      rows: ReadonlyArray<{ name: string; value: string | null }> | undefined,
    ) =>
      Object.fromEntries(
        (rows ?? [])
          .map((row) => [row.name.trim(), row.value ?? keep(kind, row.name.trim())] as const)
          .filter(([name, value]) => name.length > 0 && typeof value === "string"),
      );
    const oauth = input.oauth
      ? {
          ...(input.oauth.clientId ? { clientId: input.oauth.clientId } : {}),
          ...(input.oauth.callbackPort ? { callbackPort: input.oauth.callbackPort } : {}),
        }
      : undefined;
    if (input.transport === "stdio") {
      const env = pairs("env", input.env);
      // Arguments sent back as `get` masked them keep the stored values, place for place, while
      // their number is unchanged; `buildConfig`'s caller refuses a mask that is left over.
      const storedArgs = asStrings(previous?.args);
      const maskedArgs = redactMcpArgs(storedArgs);
      const inputArgs = [...(input.args ?? [])].filter((arg) => arg.length > 0);
      const sameShape = inputArgs.length === storedArgs.length;
      return {
        type: "stdio",
        command: input.command ?? "",
        args: inputArgs.map((arg, at) =>
          sameShape && arg === maskedArgs[at] ? storedArgs[at]! : arg,
        ),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
    }
    const headers = pairs("headers", input.headers);
    const storedUrl = typeof previous?.url === "string" ? previous.url : undefined;
    return {
      type: input.transport,
      url: restoreUrl(input.url ?? "", storedUrl),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(oauth && Object.keys(oauth).length > 0 ? { oauth } : {}),
    };
  };

  /**
   * The URL `get` sent (masked path, no query or userinfo) becomes the stored one again; a URL edited
   * on the same origin keeps the stored query and userinfo it could not show.
   */
  const restoreUrl = (input: string, stored: string | undefined) => {
    if (!stored) return input;
    if (input === redactMcpUrl(stored)) return stored;
    const next = URL.parse(input);
    const before = URL.parse(stored);
    if (!next || !before || next.origin !== before.origin || next.search || next.username) {
      return input;
    }
    next.search = before.search;
    next.username = before.username;
    next.password = before.password;
    return next.toString();
  };

  const addJson = (
    name: string,
    scope: string,
    cwd: string,
    config: Json,
    clientSecret: string | null | undefined,
  ) =>
    runCli(
      [
        "mcp",
        "add-json",
        name,
        "-",
        "--scope",
        scope,
        ...(clientSecret ? ["--client-secret"] : []),
      ],
      cwd,
      JSON.stringify(config),
      clientSecret ? { MCP_CLIENT_SECRET: clientSecret } : {},
    );

  const validate = Effect.fn("ClaudeMcpManager.validate")(function* (
    input: ProviderMcpServerInput,
    project: ProviderMcpProject | null,
  ) {
    if (input.scope !== "user" && !project) {
      return yield* failure("save", "Pick a project for a project server.");
    }
    if (input.transport === "stdio") {
      if (!input.command?.trim()) return yield* failure("save", "Enter a command.");
    } else {
      const url = URL.parse(input.url ?? "");
      if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
        return yield* failure("save", "Enter an http or https URL.");
      }
    }
  });

  const save = (
    project: ProviderMcpProject | null,
    input: ProviderMcpServerInput,
    mode: "add" | "replace",
  ) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          yield* validate(input, project);
          const cwd = cwdFor(project, input.scope);
          const key = providerMcpServerKey(
            input.scope,
            input.scope === "user" ? null : (project?.id ?? null),
            input.name,
          );
          const { list } = yield* configured(project);
          const previous = list.find(
            (entry) => entry.name === input.name && entry.scope === input.scope,
          );
          if (mode === "add" && previous)
            return yield* failure("save", `${input.name} already exists here.`);
          const config = buildConfig(input, previous?.config);
          const built = config as Json;
          if (asStrings(built.args).includes(MASK) || String(built.url ?? "").includes(MASK)) {
            return yield* failure(
              "save",
              "A hidden value changed place. Enter it again to save the server.",
            );
          }
          // `claude mcp remove` deletes the stored client secret, so an edit passes it back.
          const keptSecret =
            mode === "replace" && previous && !input.oauth?.clientSecret
              ? yield* storedClientSecret(input.name)
              : undefined;
          if (mode === "replace" && previous) {
            const removed = yield* runCli(
              ["mcp", "remove", input.name, "--scope", input.scope],
              cwd,
            );
            if (removed.code !== 0) {
              return yield* failure(
                "save",
                `Claude couldn't save the server: ${lastLine(removed.output)}`,
              );
            }
          }
          const added = yield* addJson(
            input.name,
            input.scope,
            cwd,
            config,
            input.oauth?.clientSecret || keptSecret,
          );
          if (added.code !== 0) {
            if (mode === "replace" && previous) {
              yield* addJson(input.name, input.scope, cwd, previous.config, keptSecret);
              return yield* failure(
                "save",
                `Claude couldn't save the server: ${lastLine(added.output)}. The old settings were kept.`,
              );
            }
            return yield* failure(
              "save",
              `Claude couldn't save the server: ${lastLine(added.output)}`,
            );
          }
          return key;
        }),
      )
      .pipe(
        Effect.tap((key) => lock.withPermits(1)(runCheck(project, key))),
        Effect.andThen(refOf(project)),
        Effect.flatMap(SubscriptionRef.get),
      );

  const remove = (project: ProviderMcpProject | null, key: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const entry = yield* findConfigured(project, key);
        const cwd = cwdFor(project, entry.scope);
        const { signedIn } = yield* configured(project);
        // A failed sign-out leaves a token Claude no longer uses once the server is gone.
        if (signedIn.has(entry.name))
          yield* runCli(["mcp", "logout", entry.name], cwd).pipe(Effect.ignore);
        const removed = yield* runCli(["mcp", "remove", entry.name, "--scope", entry.scope], cwd);
        if (removed.code !== 0) {
          return yield* failure(
            "remove",
            `Claude couldn't remove the server: ${lastLine(removed.output)}`,
          );
        }
        const ref = yield* refOf(project);
        yield* SubscriptionRef.update(ref, (snapshot) => ({
          ...snapshot,
          servers: snapshot.servers.filter((server) => server.key !== key),
        }));
        yield* reloadConfigured(project, ref);
        return yield* SubscriptionRef.get(ref);
      }),
    );

  const setEnabled = (project: ProviderMcpProject, key: string, enabled: boolean) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const ref = yield* refOf(project);
        const server = (yield* SubscriptionRef.get(ref)).servers.find(
          (candidate) => candidate.key === key,
        );
        if (!server) return yield* failure("setEnabled", "This server is no longer listed.");
        const toggled = yield* options
          .query({ cwd: project.root, use: (q) => q.toggleMcpServer(server.name, enabled) })
          .pipe(Effect.result);
        if (toggled._tag === "Failure") {
          return yield* failure(
            "setEnabled",
            `Claude couldn't turn ${server.name} ${enabled ? "on" : "off"}.`,
          );
        }
        if (enabled) yield* runCheck(project, key);
        yield* reloadConfigured(project, ref);
        return yield* SubscriptionRef.get(ref);
      }),
    );

  const reconnect = Effect.fn("ClaudeMcpManager.reconnect")(function* (
    project: ProviderMcpProject | null,
    key: string,
  ) {
    const ref = yield* refOf(project);
    const server = (yield* SubscriptionRef.get(ref)).servers.find(
      (candidate) => candidate.key === key,
    );
    if (!server) return yield* failure("reconnect", "This server is no longer listed.");
    const { reconnected, failed } = yield* Effect.promise(() =>
      reconnectLiveClaudeQueries(liveClaudeQueryKey(options.environment), server.name),
    );
    if (failed > 0) {
      yield* Effect.logWarning("Some running Claude sessions did not reconnect an MCP server.", {
        server: server.name,
        failed,
      });
    }
    yield* lock.withPermits(1)(runCheck(project, key));
    return { reconnected };
  });

  /** For `mcp:<key>` sign-ins: the server's name and the folder `claude mcp login` runs in. */
  const signInTarget = (key: string) => {
    const [scope, projectId, ...rest] = key.split(":");
    const name = rest.join(":");
    if (!scope || !projectId || !name) return undefined;
    const cwd =
      scope === "local" || scope === "project" ? projectRoots.get(projectId) : options.neutralCwd;
    return cwd ? { name, cwd } : undefined;
  };

  /**
   * After a sign-in or sign-out: reconnect in running threads, then check that server everywhere it
   * is listed. It runs in the background, so the sign-in flow ends when Claude is done.
   */
  const afterSignIn = (key: string) =>
    Effect.forkIn(
      afterSignInNow(key).pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("Could not refresh an MCP server after its sign-in.", {
            key,
            instanceId: options.instanceId,
            cause,
          }),
        ),
        Effect.ignore,
      ),
      scope,
    ).pipe(Effect.asVoid);
  const afterSignInNow = Effect.fn("ClaudeMcpManager.afterSignIn")(function* (key: string) {
    const target = signInTarget(key);
    if (!target) return;
    yield* Effect.promise(() =>
      reconnectLiveClaudeQueries(liveClaudeQueryKey(options.environment), target.name),
    );
    for (const [projectKey] of snapshots) {
      const project =
        projectKey === "-"
          ? null
          : { id: projectKey, name: "", root: projectRoots.get(projectKey) ?? options.neutralCwd };
      const ref = yield* refOf(project);
      const listed = (yield* SubscriptionRef.get(ref)).servers.find(
        (server) => server.key === key || server.name === target.name,
      );
      if (listed) yield* lock.withPermits(1)(runCheck(project, listed.key)).pipe(Effect.ignore);
    }
  });

  return {
    subscribe,
    check,
    get,
    save,
    remove,
    setEnabled,
    reconnect,
    signInTarget,
    afterSignIn,
  } satisfies ClaudeMcpManager;
});

export interface ClaudeMcpManager extends ProviderMcpController {
  readonly signInTarget: (
    key: string,
  ) => { readonly name: string; readonly cwd: string } | undefined;
  readonly afterSignIn: (key: string) => Effect.Effect<void>;
}
