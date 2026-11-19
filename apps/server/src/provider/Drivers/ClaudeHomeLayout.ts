import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { resolveClaudeHomePath } from "./ClaudeHome.ts";

// What Claude Code reads from its config directory besides the login. A shared `projects` keeps
// the continuation key, so threads resume natively after moving between accounts.
const SHARED_ENTRY_NAMES = [
  "CLAUDE.md",
  "settings.json",
  "keybindings.json",
  "agents",
  "commands",
  "output-styles",
  "plugins",
  "projects",
  "rules",
  "skills",
];

const AccountFile = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeAccountFile = Schema.decodeUnknownEffect(AccountFile);
const encodeAccountFile = Schema.encodeEffect(AccountFile);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class ClaudeShadowHomeError extends Schema.TaggedError<ClaudeShadowHomeError>()(
  "ClaudeShadowHomeError",
  {
    shadowHomePath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ClaudeShadowHome {
  readonly sharedHomePath: string;
  /** Claude keeps the account record and user MCP servers here, outside the default home. */
  readonly sharedAccountFile: string;
  readonly shadowHomePath: string;
}

export const resolveClaudeShadowHome = Effect.fn("resolveClaudeShadowHome")(function* (
  config: Pick<ClaudeSettings, "homePath" | "shadowHomePath">,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ClaudeShadowHome | undefined, never, Path.Path> {
  const shadowHomePath = config.shadowHomePath.trim();
  if (shadowHomePath.length === 0) return undefined;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const sharedHomePath = yield* resolveClaudeHomePath(config, environment);
  const customShared =
    config.homePath.trim().length > 0 || (environment.CLAUDE_CONFIG_DIR?.trim() ?? "") !== "";
  return {
    sharedHomePath,
    sharedAccountFile: path.join(customShared ? sharedHomePath : home, ".claude.json"),
    shadowHomePath: path.resolve(expandHomePath(shadowHomePath, home)),
  };
});

/** Links the shared configuration into the shadow home and copies the user MCP server list. */
export const materializeClaudeShadowHome = Effect.fn("materializeClaudeShadowHome")(function* (
  layout: ClaudeShadowHome,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const failure = (detail: string) => (cause?: unknown) =>
    new ClaudeShadowHomeError({ shadowHomePath: layout.shadowHomePath, detail, cause });
  if (layout.shadowHomePath === layout.sharedHomePath) {
    return yield* failure(
      `Claude shadow home path '${layout.shadowHomePath}' must differ from the CLAUDE_CONFIG_DIR path.`,
    )();
  }
  yield* fileSystem
    .makeDirectory(layout.shadowHomePath, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError(failure(`Could not create '${layout.shadowHomePath}'.`)));
  yield* fileSystem
    .makeDirectory(path.join(layout.sharedHomePath, "projects"), { recursive: true })
    .pipe(Effect.mapError(failure(`Could not create '${layout.sharedHomePath}/projects'.`)));

  yield* Effect.forEach(
    SHARED_ENTRY_NAMES,
    Effect.fnUntraced(
      function* (name) {
        const target = path.join(layout.sharedHomePath, name);
        const link = path.join(layout.shadowHomePath, name);
        if (!(yield* fileSystem.exists(target))) return;
        const linked = yield* fileSystem.readLink(link).pipe(Effect.option);
        if (linked._tag === "Some" && path.resolve(path.dirname(link), linked.value) === target) {
          return;
        }
        if (linked._tag === "None" && (yield* fileSystem.exists(link))) {
          return yield* failure(
            `'${link}' is not a link to '${target}'. Move it aside so T3 Code can share it.`,
          )();
        }
        if (linked._tag === "Some") yield* fileSystem.remove(link);
        yield* fileSystem.symlink(target, link);
      },
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.fail(
            failure(
              `Could not link the shared Claude configuration into '${layout.shadowHomePath}'.`,
            )(cause),
          ),
      }),
    ),
    { discard: true },
  );

  // The shared file is rewritten often; one that cannot be read now is read on the next check.
  const shared = yield* fileSystem.readFileString(layout.sharedAccountFile).pipe(
    Effect.flatMap(decodeAccountFile),
    Effect.orElseSucceed(() => undefined),
  );
  if (shared === undefined) return;
  const accountFile = path.join(layout.shadowHomePath, ".claude.json");
  const account = yield* fileSystem.readFileString(accountFile).pipe(
    Effect.flatMap(decodeAccountFile),
    Effect.catchReason("PlatformError", "NotFound", () =>
      Effect.succeed<Record<string, unknown>>({}),
    ),
    Effect.mapError(failure(`Could not read '${accountFile}'.`)),
  );
  // Servers added to this account alone stay; the shared ones follow the main account.
  const servers = { ...asRecord(account.mcpServers), ...asRecord(shared.mcpServers) };
  const [current, wanted] = yield* Effect.all([
    encodeJson(account.mcpServers ?? {}),
    encodeJson(servers),
  ]).pipe(Effect.mapError(failure(`Could not read the MCP servers in '${accountFile}'.`)));
  if (current === wanted) return;
  // Claude rewrites this file whole; replace it in one step so it never reads half of it.
  const pending = yield* fileSystem
    .makeTempFile({ directory: layout.shadowHomePath, prefix: ".claude.json.t3-" })
    .pipe(Effect.mapError(failure(`Could not update the MCP servers in '${accountFile}'.`)));
  yield* encodeAccountFile({ ...account, mcpServers: servers }).pipe(
    Effect.flatMap((text) => fileSystem.writeFileString(pending, text, { mode: 0o600 })),
    Effect.andThen(fileSystem.rename(pending, accountFile)),
    Effect.tapError(() => fileSystem.remove(pending).pipe(Effect.ignore)),
    Effect.mapError(failure(`Could not update the MCP servers in '${accountFile}'.`)),
  );
});

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
