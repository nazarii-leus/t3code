import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  ProjectId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ProviderMcpScope = Schema.Literals([
  "user",
  "local",
  "project",
  "plugin",
  "claudeai",
  "managed",
  "other",
]);
export type ProviderMcpScope = typeof ProviderMcpScope.Type;

export const ProviderMcpWritableScope = Schema.Literals(["user", "local", "project"]);
export type ProviderMcpWritableScope = typeof ProviderMcpWritableScope.Type;

/** Names Claude accepts for `claude mcp add`. */
export const ProviderMcpServerName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);

/** "<scope>:<projectId|->:<name>", unique within one snapshot. */
export const ProviderMcpServerKey = TrimmedNonEmptyString.check(Schema.isMaxLength(400));
export type ProviderMcpServerKey = typeof ProviderMcpServerKey.Type;

export const ProviderMcpServer = Schema.Struct({
  key: ProviderMcpServerKey,
  name: TrimmedNonEmptyString,
  scope: ProviderMcpScope,
  /** Plugin name, or the claude.ai account's name. */
  scopeDetail: Schema.NullOr(Schema.String),
  transport: Schema.Literals(["http", "sse", "stdio", "ws", "other"]),
  /** URL without query and userinfo, or the command with token-like arguments masked. */
  target: Schema.String,
  headerNames: Schema.Array(Schema.String),
  envNames: Schema.Array(Schema.String),
  state: Schema.Literals(["connected", "needs-auth", "failed", "disabled", "unknown"]),
  checking: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  tools: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        readOnly: Schema.Boolean,
        destructive: Schema.Boolean,
      }),
    ),
  ),
  signedIn: Schema.NullOr(Schema.Boolean),
  canEdit: Schema.Boolean,
  canRemove: Schema.Boolean,
  canToggle: Schema.Boolean,
  canSignIn: Schema.Boolean,
});
export type ProviderMcpServer = typeof ProviderMcpServer.Type;

export const ProviderMcpSnapshot = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  projectName: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(IsoDateTime),
  checking: Schema.Boolean,
  error: Schema.NullOr(Schema.String),
  servers: ForwardCompatibleArray(ProviderMcpServer),
});
export type ProviderMcpSnapshot = typeof ProviderMcpSnapshot.Type;

const SecretFieldValue = Schema.NullOr(Schema.String.check(Schema.isMaxLength(16_384)));
const FieldName = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

export const ProviderMcpServerInput = Schema.Struct({
  scope: ProviderMcpWritableScope,
  name: ProviderMcpServerName,
  transport: Schema.Literals(["http", "sse", "stdio"]),
  url: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
  /** A null value keeps the stored one. */
  headers: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: FieldName, value: SecretFieldValue })).check(
      Schema.isMaxLength(32),
    ),
  ),
  command: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
  args: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(4_096))).check(Schema.isMaxLength(64)),
  ),
  env: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: FieldName, value: SecretFieldValue })).check(
      Schema.isMaxLength(64),
    ),
  ),
  oauth: Schema.optionalKey(
    Schema.Struct({
      clientId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
      clientSecret: Schema.optionalKey(SecretFieldValue),
      callbackPort: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
      ),
    }),
  ),
});
export type ProviderMcpServerInput = typeof ProviderMcpServerInput.Type;

export const ProviderMcpTarget = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: Schema.NullOr(ProjectId),
});
export type ProviderMcpTarget = typeof ProviderMcpTarget.Type;

export const ProviderMcpCheckInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: Schema.NullOr(ProjectId),
  key: Schema.NullOr(ProviderMcpServerKey),
});
export type ProviderMcpCheckInput = typeof ProviderMcpCheckInput.Type;

export const ProviderMcpSaveInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: Schema.NullOr(ProjectId),
  input: ProviderMcpServerInput,
  mode: Schema.Literals(["add", "replace"]),
});
export type ProviderMcpSaveInput = typeof ProviderMcpSaveInput.Type;

export const ProviderMcpServerRefInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: Schema.NullOr(ProjectId),
  key: ProviderMcpServerKey,
});
export type ProviderMcpServerRefInput = typeof ProviderMcpServerRefInput.Type;

export const ProviderMcpSetEnabledInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
  key: ProviderMcpServerKey,
  enabled: Schema.Boolean,
});
export type ProviderMcpSetEnabledInput = typeof ProviderMcpSetEnabledInput.Type;

/** What the Edit dialog needs: values never leave the server, only whether one is stored. */
export const ProviderMcpServerConfigView = Schema.Struct({
  key: ProviderMcpServerKey,
  scope: ProviderMcpWritableScope,
  name: TrimmedNonEmptyString,
  transport: Schema.Literals(["http", "sse", "stdio"]),
  url: Schema.NullOr(Schema.String),
  headerNames: Schema.Array(Schema.String),
  command: Schema.NullOr(Schema.String),
  args: Schema.Array(Schema.String),
  envNames: Schema.Array(Schema.String),
  oauthClientId: Schema.NullOr(Schema.String),
  oauthHasClientSecret: Schema.Boolean,
  oauthCallbackPort: Schema.NullOr(Schema.Int),
});
export type ProviderMcpServerConfigView = typeof ProviderMcpServerConfigView.Type;

export class ProviderMcpError extends Schema.TaggedError<ProviderMcpError>()("ProviderMcpError", {
  instanceId: ProviderInstanceId,
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export const providerMcpServerKey = (
  scope: ProviderMcpScope,
  projectId: string | null,
  name: string,
): string => `${scope}:${projectId ?? "-"}:${name}`;

export const PROVIDER_MCP_METHOD_PREFIX = "mcp:";
