// Context tags are runtime singletons; drivers need multiple instances.
import type {
  ProviderAccountsError,
  ProviderAccountsSnapshot,
  ProviderAccountSwitchEntry,
  ProviderMcpError,
  ProviderMcpServerConfigView,
  ProviderMcpServerInput,
  ProviderMcpSnapshot,
  ProviderConsumeResetCreditOutcome,
  AcpRegistryListSessionsResult,
  AcpRegistryListProvidersResult,
  AcpRegistryOperationError,
  AcpRegistrySetProviderInput,
  ProviderDriverKind,
  ResolvedProviderInstanceEnvironment,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderWorkspaceSnapshot,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type * as ProviderAdapter from "./ProviderAdapter.ts";
import type { ProviderAuthController } from "./auth.ts";
import type { ProviderDriverError } from "./errors.ts";
import type { ManagedServerProvider } from "./snapshot.ts";
import type { ProviderTextGeneration } from "./textGeneration.ts";
import type { ProviderUsageReader } from "./usage.ts";

export interface ProviderDriverMetadata {
  readonly displayName: string;
  /** Defaults to true; false rejects multiple instances of a global resource. */
  readonly supportsMultipleInstances?: boolean;
  readonly hasDefaultInstance?: boolean;
}

export type ProviderWorkspaceSnapshot = ServerProvider &
  Pick<ServerProviderWorkspaceSnapshot, "slashCommandsPending" | "optionDescriptors"> & {
    /** Set only when the directory's catalog differs from the machine snapshot's. */
    readonly workspaceModels?: ServerProviderWorkspaceSnapshot["models"];
    /** The directory's catalog could not be read, so keep the models found before. */
    readonly workspaceModelsPending?: boolean;
  };

export interface ProviderInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly continuationIdentity: ProviderContinuationIdentity;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly snapshot: ManagedServerProvider;
  readonly snapshotForCwd?: (
    cwd: string,
  ) => Effect.Effect<ProviderWorkspaceSnapshot, ProviderDriverError>;
  /**
   * Cwds whose workspace skills may have changed. The registry rescans only cwds already
   * requested. The stream must end when the instance is torn down.
   */
  readonly workspaceRescans?: Stream.Stream<string>;
  readonly refreshModels?: () => Effect.Effect<void, ProviderDriverError>;
  readonly invalidateCaches?: Effect.Effect<void>;
  /** Moves a long-lived service onto a newly updated binary before its version is read back. */
  readonly afterUpdate?: Effect.Effect<void, ProviderDriverError>;
  readonly consumeResetCredit?: (
    creditId: string | undefined,
  ) => Effect.Effect<ProviderConsumeResetCreditOutcome, ProviderDriverError>;
  readonly orchestrationAdapter: ProviderAdapter.ProviderAdapterV2["Service"];
  readonly textGeneration: ProviderTextGeneration;
  readonly auth?: ProviderAuthController;
  /** Accounts of a provider that keeps one active login in one folder (Claude). */
  readonly accounts?: ProviderAccountsController;
  /** MCP servers of the provider's folder, and of a project when one is given. */
  readonly mcp?: ProviderMcpController;
  readonly acpSessionManagement?: {
    readonly listSessions: (input: {
      readonly cwd: string;
      readonly cursor?: string;
    }) => Effect.Effect<AcpRegistryListSessionsResult, AcpRegistryOperationError>;
    readonly logout: (cwd: string) => Effect.Effect<void, AcpRegistryOperationError>;
    readonly deleteSession: (input: {
      readonly cwd: string;
      readonly sessionId: string;
    }) => Effect.Effect<void, AcpRegistryOperationError>;
    readonly listProviders: (
      cwd: string,
    ) => Effect.Effect<AcpRegistryListProvidersResult, AcpRegistryOperationError>;
    readonly setProvider: (
      input: Omit<AcpRegistrySetProviderInput, "instanceId" | "projectId"> & {
        readonly cwd: string;
      },
    ) => Effect.Effect<void, AcpRegistryOperationError>;
    readonly disableProvider: (input: {
      readonly cwd: string;
      readonly providerId: string;
    }) => Effect.Effect<void, AcpRegistryOperationError>;
  };
}

export interface ProviderAccountsController {
  readonly snapshot: Effect.Effect<ProviderAccountsSnapshot>;
  readonly use: (
    accountId: string,
    initiator: ProviderAccountSwitchEntry["initiator"],
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
  readonly resumeAutoSwitch: Effect.Effect<ProviderAccountsSnapshot, ProviderAccountsError>;
  /**
   * After a usage-limit failure at `failedAt` (null: a turn about to start now). Returns the account
   * names when the thread should continue now on another account, or undefined when none has room.
   */
  readonly switchForLimit: (input: {
    readonly failedAt: string | null;
    readonly windowId: string | null;
    readonly windowLabel: string | null;
    readonly resetAt: string | null;
    readonly modelsInUse: ReadonlyArray<string>;
  }) => Effect.Effect<{ readonly fromName: string; readonly toName: string } | undefined>;
  readonly activeId: Effect.Effect<string | null>;
}

export interface ProviderMcpProject {
  readonly id: string;
  readonly name: string;
  readonly root: string;
}

export interface ProviderMcpController {
  readonly subscribe: (
    project: ProviderMcpProject | null,
  ) => Stream.Stream<ProviderMcpSnapshot, ProviderMcpError>;
  readonly check: (
    project: ProviderMcpProject | null,
    key: string | null,
  ) => Effect.Effect<ProviderMcpSnapshot, ProviderMcpError>;
  readonly get: (
    project: ProviderMcpProject | null,
    key: string,
  ) => Effect.Effect<ProviderMcpServerConfigView, ProviderMcpError>;
  readonly save: (
    project: ProviderMcpProject | null,
    input: ProviderMcpServerInput,
    mode: "add" | "replace",
  ) => Effect.Effect<ProviderMcpSnapshot, ProviderMcpError>;
  readonly remove: (
    project: ProviderMcpProject | null,
    key: string,
  ) => Effect.Effect<ProviderMcpSnapshot, ProviderMcpError>;
  readonly setEnabled: (
    project: ProviderMcpProject,
    key: string,
    enabled: boolean,
  ) => Effect.Effect<ProviderMcpSnapshot, ProviderMcpError>;
  readonly reconnect: (
    project: ProviderMcpProject | null,
    key: string,
  ) => Effect.Effect<{ readonly reconnected: number }, ProviderMcpError>;
}

export interface ProviderContinuationIdentity {
  readonly driverKind: ProviderDriverKind;
  readonly continuationKey: string;
}

export function defaultProviderContinuationIdentity(input: {
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
}): ProviderContinuationIdentity {
  return {
    driverKind: input.driverKind,
    continuationKey: `${input.driverKind}:instance:${input.instanceId}`,
  };
}

export interface ProviderDriverCreateInput<Config> {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly environment: ResolvedProviderInstanceEnvironment;
  readonly enabled: boolean;
  readonly config: Config;
}

/** create calls with different instanceId/config must share no mutable state. */
export interface ProviderDriver<Config, R = never, UsageR = never> {
  readonly driverKind: ProviderDriverKind;
  readonly metadata: ProviderDriverMetadata;
  // Codec keeps DecodingServices = never; Schema would widen it through AnyProviderDriver.
  readonly configSchema: Schema.Codec<Config, unknown>;
  readonly defaultConfig: () => Config;
  /** Failures become unavailable snapshots; never throw defects. */
  readonly create: (
    input: ProviderDriverCreateInput<Config>,
  ) => Effect.Effect<ProviderInstance, ProviderDriverError, R | Scope.Scope>;
  readonly usage?: ProviderUsageReader<Config, UsageR>;
}

export type AnyProviderDriver<R = never, UsageR = unknown> = ProviderDriver<any, R, UsageR>;

export type ProviderUsageReaderEnv<Driver> =
  Driver extends ProviderDriver<any, any, infer UsageR> ? UsageR : never;
