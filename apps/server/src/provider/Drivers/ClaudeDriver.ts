// @effect-diagnostics nodeBuiltinImport:off - the store folder is named by a hash of the Claude folder.
import * as NodeCrypto from "node:crypto";

import { ClaudeSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import type * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  createClaudeAdapterV2,
  type ClaudeAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ProviderDriverError } from "../Errors.ts";
import { claudeUsageReader } from "./claudeUsage.ts";
import { makeClaudeScopedLimitNames } from "../claudeUsageLimits.ts";
import * as ClaudeResetCredits from "../claudeResetCredits.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
  probeClaudeWorkspaceSnapshot,
  type ClaudeCapabilitiesProbe,
} from "../ClaudeProvider.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import { resolveClaudeModelCatalog } from "../ClaudeModelCatalog.ts";
import {
  makeClaudeCodeModelRoutes,
  resolveClaudeModelSettingsKey,
} from "../ClaudeCodeModelRoutes.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { enrichProviderSnapshotWithVersionAdvisory } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  mergeClaudeProcessEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";
import type { ProviderAuthController } from "@t3tools/provider-core/server/auth";
import { makeClaudeAuth } from "./ClaudeAuth.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { makeClaudeAccounts, type ClaudeAccounts } from "../claudeAccounts/ClaudeAccounts.ts";
import { ClaudeAccountStoreError } from "../claudeAccounts/ClaudeAccountStore.ts";
import * as DateTime from "effect/DateTime";
import { claudeUsageResponseToLimits } from "../claudeUsageLimits.ts";
import { runClaudeCommand, withClaudeMcpQuery } from "../ClaudeProvider.ts";
import { makeClaudeMcpManager } from "../claudeMcp/ClaudeMcpManager.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makeClaudeMaintenanceResolution } from "./ClaudeMaintenance.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

const withoutUsage = (capabilities: ClaudeCapabilitiesProbe): ClaudeCapabilitiesProbe => {
  const result = { ...capabilities };
  delete result.usage;
  return result;
};

export type ClaudeDriverEnv =
  | ClaudeAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | ResetCreditCoordinator.ResetCreditCoordinator
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig;

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  usage: claudeUsageReader,
  create: Effect.fn("ClaudeDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // The server cwd is $HOME in packaged desktop builds, and `claude`
    // wrappers that scope themselves to their cwd refuse to run there.
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const resetCreditCoordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
    const catalogService = yield* ModelCatalog.ModelCatalog;
    const modelCatalog = catalogService
      .current(DRIVER_KIND)
      .pipe(Effect.map(resolveClaudeModelCatalog));
    const processEnv = yield* mergeClaudeProcessEnvironment(config, environment, process.env);
    // Every account of this provider uses this one folder; switching moves only the login.
    const accountConfig = config;
    const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const effectiveConfig = {
      ...accountConfig,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
    } satisfies ClaudeSettings;
    const resolveMaintenance = yield* makeClaudeMaintenanceResolution({
      binaryPath: effectiveConfig.binaryPath,
      env: processEnv,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    const continuationGroupKey = yield* makeClaudeContinuationGroupKey(effectiveConfig, processEnv);
    const configDir = yield* resolveClaudeHomePath(effectiveConfig, processEnv);
    const accountConfigPath = yield* ClaudeResetCredits.claudeAccountConfigPath(
      effectiveConfig.homePath.trim() || processEnv.CLAUDE_CONFIG_DIR?.trim()
        ? configDir
        : undefined,
    );
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey,
    });

    const scopedLimitNames = yield* makeClaudeScopedLimitNames;
    // The SDK's user source is the host's home, not a custom one; same rule as the adapter.
    const customHome =
      effectiveConfig.homePath.trim().length > 0 ||
      processEnv.CLAUDE_CONFIG_DIR !== (yield* HostProcess.Environment).CLAUDE_CONFIG_DIR;
    // Only a successful probe records routes, so a failed one never sends turns back to slugs
    // the backend rejects.
    const modelRoutes = yield* makeClaudeCodeModelRoutes(
      (cwd) =>
        resolveClaudeModelSettingsKey(
          customHome ? ["project", "local"] : ["user", "project", "local"],
          cwd,
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      stateDir,
    );
    // Retain reports until the registry subscribes; end its listener on teardown.
    const workspaceRescans = yield* Queue.unbounded<string, Cause.Done>();
    yield* Effect.addFinalizer(() => Queue.end(workspaceRescans));
    const orchestrationAdapter = yield* createClaudeAdapterV2(
      {
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config: accountConfig,
      },
      {
        scopedLimitNames,
        onUsageLimits: (update) => snapshot.applyUsageLimits(update),
        onSessionInit: (cwd) => Queue.offer(workspaceRescans, cwd).pipe(Effect.asVoid),
        modelCatalog,
        routeModelCatalog: modelRoutes.route,
      },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Claude orchestration adapter.",
            cause,
          }),
      ),
    );
    const textGeneration = yield* makeClaudeTextGeneration(
      effectiveConfig,
      processEnv,
      modelCatalog,
      modelRoutes.route,
    );

    // Per-instance capabilities cache: keyed on binary + resolved HOME so
    // account-specific probes never share auth metadata across instances.
    // A transient miss may reuse the last account once, but its usage windows keep their age.
    const lastGoodCapabilities = yield* Ref.make<ClaudeCapabilitiesProbe | undefined>(undefined);
    const capabilitiesProbeCache = yield* Cache.makeWith(
      () =>
        probeClaudeCapabilities(effectiveConfig, processEnv, stateDir).pipe(
          Effect.flatMap((capabilities) =>
            ClaudeResetCredits.readClaudeOrganizationId(accountConfigPath).pipe(
              Effect.map((workspaceId) => ({
                _tag: "fresh" as const,
                capabilities:
                  workspaceId === undefined ? capabilities : { ...capabilities, workspaceId },
              })),
            ),
          ),
          Effect.tap(({ capabilities }) =>
            Ref.set(lastGoodCapabilities, capabilities).pipe(
              Effect.andThen(modelRoutes.record(capabilities.models ?? [])),
            ),
          ),
          Effect.ensuring(modelRoutes.settle),
          Effect.catch((error) =>
            Ref.getAndSet(lastGoodCapabilities, undefined).pipe(
              Effect.flatMap((capabilities) =>
                capabilities === undefined
                  ? Effect.fail(error)
                  : ClaudeResetCredits.readClaudeOrganizationId(accountConfigPath).pipe(
                      Effect.flatMap((workspaceId) =>
                        workspaceId === capabilities.workspaceId
                          ? Effect.succeed({
                              _tag: "fallback" as const,
                              capabilities: withoutUsage(capabilities),
                            })
                          : Effect.fail(error),
                      ),
                    ),
              ),
            ),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      {
        capacity: 1,
        timeToLive: (exit) =>
          // Only fresh usage earns the TTL; failures, fallbacks and usage-less probes retry.
          Exit.isSuccess(exit) &&
          exit.value._tag === "fresh" &&
          exit.value.capabilities.usage !== undefined
            ? CAPABILITIES_PROBE_TTL
            : Duration.zero,
      },
    );
    const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(
      effectiveConfig,
      stateDir,
      processEnv,
    );
    const resolveCapabilities = Cache.get(capabilitiesProbeCache, capabilitiesCacheKey).pipe(
      Effect.map((result) => result.capabilities),
    );

    const signInAvailable = (yield* HostProcess.Platform) !== "win32";
    // `claude auth login` cannot replace an API key, Bedrock or a custom endpoint.
    const withSignIn = (provider: ServerProvider): ServerProvider =>
      !signInAvailable || ["apiKey", "bedrock", "customEndpoint"].includes(provider.auth.type ?? "")
        ? provider
        : {
            ...provider,
            setup: { ...provider.setup, canAuthenticate: true, canInstall: false },
            ...(provider.auth.status === "unauthenticated"
              ? { message: "Sign in to use this account." }
              : {}),
          };

    // Set once the sign-in exists; each check re-reads the account's MCP servers and their sign-ins.
    const authRef = yield* Ref.make<ProviderAuthController | undefined>(undefined);
    const checkProvider = Ref.get(authRef).pipe(
      Effect.flatMap((auth) => auth?.refreshMethods ?? Effect.void),
      Effect.andThen(catalogService.refreshInBackground),
      Effect.andThen(
        modelCatalog.pipe(
          Effect.flatMap((catalog) =>
            checkClaudeProviderStatus(
              effectiveConfig,
              () => resolveCapabilities,
              processEnv,
              stateDir,
              catalog,
              scopedLimitNames,
              (version) =>
                ClaudeResetCredits.readClaudeResetCredits(configDir, version).pipe(
                  Effect.provideService(HttpClient.HttpClient, httpClient),
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.provideService(Path.Path, path),
                ),
            ),
          ),
          Effect.tap((provider) =>
            provider.auth.status === "unauthenticated"
              ? Cache.invalidateAll(capabilitiesProbeCache)
              : Effect.void,
          ),
          Effect.map(stampIdentity),
          Effect.map(withSignIn),
        ),
      ),
      // Disabled, failed version checks and interruption never reach the probe.
      Effect.ensuring(modelRoutes.settle),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClaudeSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        modelCatalog.pipe(
          Effect.flatMap((catalog) => makePendingClaudeProvider(settings.provider, catalog)),
          Effect.map(stampIdentity),
          Effect.map(withSignIn),
        ),
      checkProvider,
      invalidateUsageCache: Cache.invalidateAll(capabilitiesProbeCache),
      enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
            cause,
          }),
      ),
    );

    // Same rules as Codex: serialised on the config directory that holds the
    // login, one request id kept until Claude answers (a cooldown or rate
    // limit is an answer), then a re-probe.
    const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = Effect.fn(
      "ClaudeDriver.consumeResetCredit",
    )(
      function* (creditId) {
        const current = yield* snapshot.getSnapshot;
        const credits = current.usageLimits?.resetCredits;
        const grantId =
          creditId === undefined
            ? credits?.nextCreditId
            : credits?.options?.some((option) => option.creditId === creditId)
              ? creditId
              : undefined;
        if (!grantId || !current.version) return "noCredit" as const;
        const version = current.version;
        return yield* resetCreditCoordinator.redeem(
          configDir,
          (requestId) =>
            ClaudeResetCredits.consumeClaudeResetCredit({
              configDir,
              accountConfigPath,
              version,
              grantId,
              requestId,
            }),
          ClaudeResetCredits.isSettledClaudeResetCreditFailure,
        );
      },
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail:
              cause._tag === "ClaudeResetCreditError"
                ? cause.message
                : "Claude could not redeem the reset.",
            cause,
          }),
      ),
      Effect.tap((outcome) =>
        ResetCreditCoordinator.refreshAfterRedemption({
          outcome,
          getSnapshot: snapshot.getSnapshot,
          refresh: Cache.invalidateAll(capabilitiesProbeCache).pipe(
            Effect.andThen(snapshot.refresh),
          ),
        }).pipe(
          Effect.filterOrFail(
            (confirmed) => confirmed,
            () =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail:
                  "The reset was applied, but Claude could not confirm the new limits. Refresh to check.",
              }),
          ),
        ),
      ),
    );

    const platform = yield* HostProcess.Platform;
    const folderKey = yield* fileSystem.realPath(configDir).pipe(
      Effect.orElseSucceed(() => configDir),
      Effect.map((real) => NodeCrypto.createHash("sha256").update(real).digest("hex").slice(0, 12)),
    );
    const storeDir = path.join(stateDir, "provider-accounts", "claude", folderKey);
    yield* fileSystem.makeDirectory(storeDir, { recursive: true, mode: 0o700 }).pipe(Effect.ignore);
    yield* fileSystem
      .writeFileString(path.join(storeDir, "folder.txt"), configDir)
      .pipe(Effect.ignore);
    const refreshActive = Cache.invalidateAll(capabilitiesProbeCache).pipe(
      Effect.andThen(snapshot.refresh),
      Effect.asVoid,
    );
    const accounts: ClaudeAccounts = yield* makeClaudeAccounts({
      instanceId,
      folder: configDir,
      profileFile: accountConfigPath,
      storeDir,
      platform,
      probeStored: (accountDir) =>
        probeClaudeCapabilities(
          { ...effectiveConfig, homePath: accountDir },
          processEnv,
          accountDir,
        ).pipe(
          Effect.flatMap((capabilities) =>
            DateTime.now.pipe(
              Effect.map((now) => ({
                models: capabilities.models?.map((model) => model.value),
                usageLimits: capabilities.usage
                  ? claudeUsageResponseToLimits({
                      response: capabilities.usage,
                      checkedAt: capabilities.usageCheckedAt ?? DateTime.formatIso(now),
                    }).limits
                  : undefined,
              })),
            ),
          ),
          Effect.mapError(
            (cause) =>
              new ClaudeAccountStoreError({
                operation: "probe",
                detail: cause.message || "Claude could not check this account.",
                cause,
              }),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      runClaude: (dir, args) =>
        runClaudeCommand({ ...effectiveConfig, homePath: dir }, args, processEnv, dir).pipe(
          Effect.map((result) => ({ code: result.code })),
          Effect.mapError(
            (cause) =>
              new ClaudeAccountStoreError({ operation: "command", detail: cause.message, cause }),
          ),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(Path.Path, path),
        ),
      activeSnapshot: snapshot.getSnapshot,
      refreshActive,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    // The provider snapshot carries the account list; it is re-sent when either side changes.
    const accountsRef = yield* SubscriptionRef.make(yield* accounts.snapshot);
    yield* Effect.forkScoped(
      Stream.runForEach(accounts.changes, (next) => SubscriptionRef.set(accountsRef, next)),
    );
    const withAccounts = (provider: ServerProvider) =>
      SubscriptionRef.get(accountsRef).pipe(
        Effect.map((list) => ({ ...provider, accounts: list })),
      );
    const snapshotWithAccounts = {
      ...snapshot,
      getSnapshot: snapshot.getSnapshot.pipe(Effect.flatMap(withAccounts)),
      refresh: snapshot.refresh.pipe(Effect.flatMap(withAccounts)),
      streamChanges: Stream.zipLatestWith(
        snapshot.streamChanges,
        SubscriptionRef.changes(accountsRef),
        (provider, list) => ({ ...provider, accounts: list }),
      ),
    } satisfies typeof snapshot;

    // Accounts are re-rendered when the active account's own snapshot changes (its usage, its login).
    yield* Effect.forkScoped(Stream.runForEach(snapshot.streamChanges, () => accounts.refresh));
    const neutralCwd = path.join(storeDir, "mcp-cwd");
    yield* fileSystem
      .makeDirectory(neutralCwd, { recursive: true, mode: 0o700 })
      .pipe(Effect.ignore);
    const claudeEnvironment = yield* makeClaudeEnvironment(effectiveConfig, processEnv);
    const mcp = yield* makeClaudeMcpManager({
      instanceId,
      folder: configDir,
      profileFile: accountConfigPath,
      neutralCwd,
      binaryPath: effectiveConfig.binaryPath,
      environment: claudeEnvironment,
      query: (input) =>
        withClaudeMcpQuery({
          claudeSettings: effectiveConfig,
          environment: processEnv,
          cwd: input.cwd,
          ...(input.only ? { only: input.only } : {}),
          use: input.use,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      activeAccountName: accounts.snapshot.pipe(
        Effect.map((list) => list.accounts.find((account) => account.active)?.name ?? null),
      ),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

    const auth = signInAvailable
      ? yield* makeClaudeAuth({
          instanceId,
          binaryPath: effectiveConfig.binaryPath,
          environment: yield* makeClaudeEnvironment(effectiveConfig, processEnv),
          configDir,
          cwd: stateDir,
          accounts,
          mcp,
          refresh: Cache.invalidateAll(capabilitiesProbeCache).pipe(
            Effect.andThen(snapshot.refresh),
          ),
        })
      : undefined;
    yield* Ref.set(authRef, auth);

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      ...(auth ? { auth } : {}),
      accounts,
      mcp,
      continuationIdentity: {
        ...fallbackContinuationIdentity,
        continuationKey: continuationGroupKey,
      },
      displayName,
      accentColor,
      enabled,
      snapshot: snapshotWithAccounts,
      invalidateCaches: Cache.invalidateAll(capabilitiesProbeCache),
      workspaceRescans: Stream.fromQueue(workspaceRescans),
      snapshotForCwd: (cwd: string) =>
        snapshot.getSnapshot.pipe(
          Effect.flatMap((machineSnapshot) =>
            probeClaudeWorkspaceSnapshot(effectiveConfig, machineSnapshot, cwd, processEnv),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      orchestrationAdapter,
      textGeneration,
      consumeResetCredit,
    } satisfies ProviderInstance;
  }),
};
