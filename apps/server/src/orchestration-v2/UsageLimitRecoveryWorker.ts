import {
  CommandId,
  MessageId,
  PROVIDER_DISPLAY_NAMES,
  type OrchestrationV2Command,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import { resolveLimitSwitchSelection } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export const MAX_OVERDUE_ARM_MS = 24 * 60 * 60 * 1000;

export function limitRecoveryCommand(
  thread: ProjectionStore.ProjectionLimitRecoveryCandidate,
  autoResume: boolean,
  nowMs: number,
  snooze = false,
): OrchestrationV2Command | null {
  if (
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null
  )
    return null;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  // An already-expired window reported with a fresh failure cannot start a retry loop.
  if (
    !Number.isFinite(resetMs) ||
    resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
  )
    return null;
  const identity = `${thread.id}:${thread.latestRunId}:${resetMs}`;
  const recovery = thread.limitRecovery;
  if (recovery?.runId !== thread.latestRunId || recovery.resetAt !== thread.usageLimitResetAt) {
    if (nowMs - resetMs > MAX_OVERDUE_ARM_MS) return null;
    if (!autoResume && (!snooze || resetMs <= nowMs)) return null;
    return {
      type: "thread.metadata.update",
      commandId: CommandId.make(`limit-arm:${identity}`),
      threadId: thread.id,
      limitRecovery: {
        runId: thread.latestRunId,
        resetAt: thread.usageLimitResetAt,
        autoResume,
        snooze: snooze && resetMs > nowMs,
      },
    };
  }
  if (
    !recovery.autoResume ||
    resetMs > nowMs ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs)
  )
    return null;
  const deliveryIdentity = `${identity}:${recovery.requestId ?? "legacy"}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-resume:${deliveryIdentity}`),
    messageId: MessageId.make(`limit-resume:${deliveryIdentity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    ...(recovery.requestId === undefined
      ? {}
      : { usageLimitRecoveryRequestId: recovery.requestId }),
    text: "Continue where you left off.",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  };
}

/** A limited thread the automatic switch may continue on another account right now. */
function limitSwitchEligible(
  thread: ProjectionStore.ProjectionLimitSwitchCandidate,
  settings: ServerSettingsValue,
  nowMs: number,
): boolean {
  return !(
    !settings.switchAccountsAtUsageLimits ||
    thread.status !== "failed" ||
    thread.lastErrorClass !== "usage_limit" ||
    !thread.latestRunId ||
    !thread.usageLimitResetAt ||
    !(Date.parse(thread.usageLimitResetAt) > nowMs) ||
    // A thread the user already moved to another account is theirs to send.
    !thread.limitedInstanceIds.includes(thread.modelSelection.instanceId) ||
    thread.archivedAt !== null ||
    thread.settledOverride === "settled" ||
    thread.pendingRuntimeRequest !== null ||
    (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > nowMs) ||
    Orchestrator.userChoseLimitRecovery(thread.limitRecovery, thread.latestRunId)
  );
}

/** Continues a limited thread on the account the provider just switched to (one folder). */
export function accountSwitchCommand(
  thread: ProjectionStore.ProjectionLimitSwitchCandidate,
  names: { readonly fromName: string; readonly toName: string },
): OrchestrationV2Command | null {
  if (!thread.latestRunId) return null;
  const text = "Continue where you left off.";
  const identity = `${thread.id}:${thread.latestRunId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-switch:${identity}`),
    messageId: MessageId.make(`limit-switch:${identity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    usageLimitSwitchedAccount: true,
    text,
    notification: {
      source: { kind: "system" },
      outcome: "updated",
      summary: `${names.fromName} ran out of usage. Continuing on ${names.toName}.`,
      detail: text,
    },
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  };
}

/** Continues a limited thread at once on another account of its provider that has usage left. */
export function limitSwitchCommand(
  thread: ProjectionStore.ProjectionLimitSwitchCandidate,
  providers: ReadonlyArray<ServerProvider>,
  settings: ServerSettingsValue,
  nowMs: number,
): OrchestrationV2Command | null {
  if (!thread.latestRunId || !limitSwitchEligible(thread, settings, nowMs)) return null;
  const selection = resolveLimitSwitchSelection({
    selection: thread.modelSelection,
    providers,
    settings,
    projectId: thread.projectId,
    now: nowMs,
    excludedInstanceIds: thread.limitedInstanceIds,
  });
  if (selection === null) return null;
  // A default instance's id is its driver kind.
  const accountName = (id: ProviderInstanceId) =>
    providers.find((provider) => provider.instanceId === id)?.displayName?.trim() ||
    PROVIDER_DISPLAY_NAMES[id as string as ProviderDriverKind] ||
    id;
  const text = "Continue where you left off.";
  const identity = `${thread.id}:${thread.latestRunId}`;
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`limit-switch:${identity}`),
    messageId: MessageId.make(`limit-switch:${identity}`),
    threadId: thread.id,
    usageLimitContinuationOfRunId: thread.latestRunId,
    modelSelection: selection,
    text,
    notification: {
      source: { kind: "system" },
      outcome: "updated",
      summary: `${accountName(thread.modelSelection.instanceId)} ran out of usage. Continuing on ${accountName(selection.instanceId)}.`,
      detail: text,
    },
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "agent",
    creationSource: "server",
  };
}

// Events that can make a thread a candidate or change its command; streaming items cannot.
const affectsLimitRecovery = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") ||
  event.type === "run.created" ||
  event.type === "run.updated" ||
  event.type === "runtime-request.updated" ||
  event.type.startsWith("provider-session.") ||
  (event.type === "turn-item.updated" && event.payload.type === "error");

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const instances = yield* Effect.serviceOption(ProviderInstanceRegistry.ProviderInstanceRegistry);
  // A provider that switches accounts in one folder (Claude) decides the switch itself.
  const accountSwitch = Effect.fn("UsageLimitRecoveryWorker.accountSwitch")(function* (
    thread: ProjectionStore.ProjectionLimitSwitchCandidate,
    providers: ReadonlyArray<ServerProvider>,
    preferences: ServerSettingsValue,
    nowMs: number,
  ) {
    const instanceId = thread.modelSelection.instanceId;
    if (
      Option.isNone(instances) ||
      providers.find((provider) => provider.instanceId === instanceId)?.accounts?.supported !==
        true ||
      !limitSwitchEligible(thread, preferences, nowMs)
    ) {
      return undefined;
    }
    const accounts = (yield* instances.value.getInstance(instanceId))?.accounts;
    if (!accounts) return undefined;
    const names = yield* accounts.switchForLimit({
      failedAt: DateTime.formatIso(thread.latestRunCompletedAt ?? thread.updatedAt),
      windowId: null,
      windowLabel: null,
      resetAt: thread.usageLimitResetAt ?? null,
      modelsInUse: [thread.modelSelection.model],
    });
    return names ? (accountSwitchCommand(thread, names) ?? undefined) : null;
  });
  const due = DueHint.make();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsLimitRecovery(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));
  // Fresh usage readings can free an account for a thread that is waiting on its reset.
  yield* forkParked(Stream.runForEach(registry.streamChanges, () => due.invalidate));
  return Effect.fn("UsageLimitRecoveryWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const preferences = yield* settings.getSettings;
    const candidates = yield* projections.getLimitRecoveryCandidates({
      now,
      autoResume: preferences.autoResumeLimitedThreads,
      snooze: preferences.snoozeLimitedThreads,
      switchAccounts: preferences.switchAccountsAtUsageLimits,
    });
    const providers = candidates.length === 0 ? [] : yield* registry.getProviders;
    let acted = false;
    for (const thread of candidates) {
      const switched = yield* accountSwitch(thread, providers, preferences, nowMs);
      const command =
        switched ??
        (switched === null ? null : limitSwitchCommand(thread, providers, preferences, nowMs)) ??
        limitRecoveryCommand(
          thread,
          preferences.autoResumeLimitedThreads,
          nowMs,
          preferences.snoozeLimitedThreads,
        );
      if (command === null) continue;
      acted = true;
      yield* Effect.gen(function* () {
        if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
          yield* orchestrator.autoArmLimitRecovery({
            commandId: command.commandId,
            threadId: command.threadId,
            limitRecovery: command.limitRecovery,
          });
        } else {
          yield* threads.dispatch(command);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestration-v2.limit-recovery.dispatch-failed", {
            threadId: thread.id,
            cause,
          }),
        ),
      );
    }
    // A sweep that acted, or failed to, re-checks on the next tick.
    if (acted) return;
    const wakeAt = yield* projections.getLimitRecoveryWakeAt(now);
    yield* due.record(readVersion, wakeAt ?? Infinity, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("usage-limit-recovery", sweep());
  }),
);
