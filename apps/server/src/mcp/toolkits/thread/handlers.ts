import {
  type CommandId,
  type RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type RunId,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
  moveSidebarTopFolder,
  removeSidebarFolder,
  renameSidebarFolder,
  renameThreadFolderPath,
  setSidebarFolderIcon,
  SIDEBAR_FOLDER_ICON_NAMES,
  type SidebarFolderEntry,
  threadFolderOf,
  upsertSidebarFolder,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { modelSelectionCommandType } from "@t3tools/shared/model";
import { topOfPinnedRunOrderKey } from "@t3tools/shared/pinOrderKey";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  dispatchFailure,
  newCommandId,
  readCaller,
  readThread,
  unavailable,
} from "../../threadAccess.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import { queuedRunsInDeliveryOrder } from "../../../orchestration-v2/QueuedRunOrder.ts";
import { ThreadToolkit } from "./tools.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import {
  knownThreadFolders,
  readThreadFolders,
  resolveThreadFolder,
  setThreadFolder,
} from "../../threadFolders.ts";

function queueEntry(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  runId: RunId,
  limit: number,
) {
  const run = projection.runs.find((run) => run.id === runId && run.status === "queued");
  const message = projection.messages.find((message) => message.id === run?.userMessageId);
  if (run === undefined || message === undefined) return undefined;
  const characters = Array.from(message.text);
  return {
    queuedRunId: run.id,
    text: characters.slice(0, limit).join(""),
    truncated: characters.length > limit,
  };
}
const dispatch = Effect.fn("mcp.dispatchThreadCommand")(function* (
  threadId: ThreadId | undefined,
  command: (common: { commandId: CommandId; threadId: ThreadId }) => OrchestrationV2Command,
) {
  const { threads, projection } = yield* readThread(threadId);
  const result = yield* threads
    .dispatch(command({ commandId: yield* newCommandId(), threadId: projection.thread.id }))
    .pipe(Effect.mapError(dispatchFailure));
  return { sequence: result.sequence };
});

/**
 * Places an agent pin at the top of the Pinned section, as a client pin is placed.
 * Without a key the sidebar sorts the pin below every keyed pin. Ordering is
 * best effort: if the index cannot be read, the pin still lands, keyless.
 */
const topOfPinnedRunKey = Effect.fn("mcp.topOfPinnedRunKey")(function* (
  threads: Pick<ThreadManagementService.ThreadManagementService["Service"], "listActiveShellIndex">,
) {
  const index = yield* threads.listActiveShellIndex().pipe(Effect.orElseSucceed(() => null));
  if (index === null) return undefined;
  const pinnedKeys = index.flatMap((entry) => (entry.pinnedAt == null ? [] : [entry.pinOrderKey]));
  return topOfPinnedRunOrderKey(pinnedKeys) ?? undefined;
});

const readQuestion = Effect.fn("mcp.readQuestion")(function* (input: {
  threadId?: ThreadId | undefined;
  requestId: RuntimeRequestId;
}) {
  const context = yield* readThread(input.threadId, ["runtimeRequests", "turnItems"]);
  const request = context.projection.runtimeRequests.find(
    (request) => request.id === input.requestId && request.kind === "user_input",
  );
  const item = context.projection.turnItems.find(
    (item) => item.type === "user_input_request" && item.requestId === input.requestId,
  );
  if (request === undefined || item?.type !== "user_input_request")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The pending user-input request was not found.",
    });
  if (request.status !== "pending")
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        request.status === "resolved"
          ? "The user-input request was already answered."
          : `The user-input request is no longer pending (${request.status}).`,
    });
  return { ...context, request, item };
});
/** A field the chosen action needs. `null` counts as given, as in `beforeRunId: null`. */
const required = <A>(value: A | undefined, name: string) =>
  value === undefined
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `This action needs \`${name}\`.`,
        }),
      )
    : Effect.succeed(value);
/** Top folders in saved order, then the rest by name; each followed by its subfolders. */
function listThreadFolders(
  layout: ReadonlyArray<SidebarFolderEntry>,
  shells: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "tags">>,
) {
  const known = knownThreadFolders(shells, layout);
  const byName = (left: string, right: string) =>
    left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
  const ordered = (paths: ReadonlyArray<string>) => {
    const saved = layout.map((entry) => entry.path).filter((path) => paths.includes(path));
    return [...new Set(saved), ...paths.filter((path) => !saved.includes(path)).toSorted(byName)];
  };
  const tops = ordered([...new Set(known.map((path) => path.split("/")[0]!))]);
  const folderOf = (shell: Pick<OrchestrationV2ThreadShell, "tags">) =>
    threadFolderOf(shell.tags)?.path;
  return tops
    .flatMap((top) => [top, ...ordered(known.filter((path) => path.startsWith(`${top}/`)))])
    .map((path) => {
      const entry = layout.find((candidate) => candidate.path === path);
      return {
        path,
        ...(entry?.icon === undefined ? {} : { icon: entry.icon }),
        ...(entry?.sort === undefined ? {} : { sort: entry.sort }),
        threadCount: shells.filter((shell) => {
          const folder = folderOf(shell);
          return folder !== undefined && renameThreadFolderPath(folder, path, path) !== null;
        }).length,
      };
    });
}

const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
  handle: (params: P) => Effect.Effect<A, E, R>,
) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

export const layer = McpToolAccess.toLayer(ThreadToolkit, {
  run_scheduled_task_now: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scheduler = yield* ScheduledTasks.ScheduledTaskService;
      const { tasks } = yield* scheduler.list().pipe(Effect.mapError(unavailable));
      if (!tasks.some((task) => task.id === input.taskId))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The scheduled task was not found.",
        });
      const { task, threadId } = yield* scheduler
        .runNow({ id: input.taskId })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
      const scope = yield* McpInvocationContext.McpInvocationContext;
      return {
        taskId: task.id,
        threadId,
        ...(threadId === null
          ? {}
          : {
              link: McpInvocationContext.threadLinkFor(scope, threadId),
            }),
        lastRunStatus: task.lastRunStatus,
        lastRunError: task.lastRunError,
        runCount: task.runCount,
        nextRunAt: task.nextRunAt,
      };
    }),
  ),
  t3_thread_search: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { caller } = yield* readCaller();
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const threadSearch = yield* ThreadSearch.ThreadSearch;
      const { matches } = yield* threadSearch
        .searchThreads({ ...input, projectId: input.projectId ?? caller?.projectId })
        .pipe(Effect.mapError(unavailable));
      return {
        currentThreadId: scope.thread?.threadId ?? null,
        matches: matches.map((match) => ({
          ...match,
          link: McpInvocationContext.threadLinkFor(scope, match.threadId, match.title),
        })),
      };
    }),
  ),
  t3_thread_transfer: McpToolAccess.either(
    (input) => input.action === "status",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId, ["contextTransfers"]);
        return {
          transfers: projection.contextTransfers.map(
            ({ id, sourceThreadId, targetThreadId, status }) => ({
              id,
              sourceThreadId,
              targetThreadId,
              status,
            }),
          ),
        };
      }),
    ),
    McpToolAccess.writesThreads(
      (input) => [input.threadId, input.targetThreadId],
      (input) =>
        Effect.gen(function* () {
          const sourcePoint = input.sourcePoint ?? { type: "latest_stable" as const };
          const { threads, projection } = yield* readThread(input.threadId);
          const commandId = yield* newCommandId();
          if (input.action === "merge_back") {
            const targetThreadId = yield* required(input.targetThreadId, "targetThreadId");
            yield* readThread(targetThreadId);
            const result = yield* threads
              .dispatch({
                type: "thread.merge_back",
                commandId,
                sourceThreadId: projection.thread.id,
                targetThreadId,
                sourcePoint,
                createdBy: "agent",
                creationSource: "mcp",
              })
              .pipe(Effect.mapError(dispatchFailure));
            return { sequence: result.sequence, targetThreadId };
          }
          const targetThreadId = ThreadId.make(`${commandId}:fork`);
          const result = yield* threads
            .dispatch({
              type: "thread.fork",
              commandId,
              sourceThreadId: projection.thread.id,
              targetThreadId,
              sourcePoint,
              ...(input.title === undefined ? {} : { title: input.title }),
              createdBy: "agent",
              creationSource: "mcp",
            })
            .pipe(Effect.mapError(dispatchFailure));
          return { sequence: result.sequence, targetThreadId };
        }),
    ),
  ),
  t3_thread_configure: McpToolAccess.either(
    (input) => input.modelSelection === undefined,
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const {
          projection: { thread },
        } = yield* readThread(input.threadId);
        return {
          threadId: thread.id,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
        };
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const modelSelection = yield* required(input.modelSelection, "modelSelection");
        const {
          threads,
          projection: { thread },
        } = yield* readThread(input.threadId);
        const type = modelSelectionCommandType(thread.providerInstanceId, modelSelection);
        const result = yield* threads
          .dispatch({ type, threadId: thread.id, commandId: yield* newCommandId(), modelSelection })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence };
      }),
    ),
  ),
  t3_pending_request: McpToolAccess.either(
    (input) => input.action !== "respond",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        if (input.action === "list") {
          const { projection } = yield* readThread(input.threadId, ["runtimeRequests"]);
          return {
            requestIds: projection.runtimeRequests
              .filter((request) => request.kind === "user_input" && request.status === "pending")
              .map((request) => request.id),
          };
        }
        const requestId = yield* required(input.requestId, "requestId");
        const { item } = yield* readQuestion({ threadId: input.threadId, requestId });
        return { requestId, questions: item.questions };
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const requestId = yield* required(input.requestId, "requestId");
        const answers = yield* required(input.answers, "answers");
        const { threads, projection } = yield* readQuestion({
          threadId: input.threadId,
          requestId,
        });
        const result = yield* threads
          .dispatch({
            type: "runtime-request.respond",
            threadId: projection.thread.id,
            commandId: yield* newCommandId(),
            requestId,
            answers,
          })
          .pipe(Effect.mapError(dispatchFailure));
        return { sequence: result.sequence };
      }),
    ),
  ),
  t3_queue: McpToolAccess.either(
    (input) => input.action === "list" || input.action === "read",
    McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const { threads, projection: queued } = yield* readThread(input.threadId, ["runs"], {
          runStatuses: ["queued"],
        });
        const messages = yield* threads
          .getMessagesById(
            queued.thread.id,
            queued.runs.map((run) => run.userMessageId),
          )
          .pipe(Effect.mapError(unavailable));
        const projection = { runs: queued.runs, messages: [...messages.values()] };
        if (input.action === "list") {
          const runs = queuedRunsInDeliveryOrder(projection);
          const cursor = input.cursor ?? 0;
          const end = cursor + (input.limit ?? 20);
          return {
            items: runs.slice(cursor, end).flatMap((run) => {
              const entry = queueEntry(projection, run.id, 1000);
              return entry === undefined ? [] : [entry];
            }),
            nextCursor: end < runs.length ? end : null,
          };
        }
        const queuedRunId = yield* required(input.queuedRunId, "queuedRunId");
        return (
          queueEntry(projection, queuedRunId, 16000) ??
          (yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The queued message was not found.",
          }))
        );
      }),
    ),
    writesThread((input) =>
      Effect.gen(function* () {
        const runId = yield* required(input.queuedRunId, "queuedRunId");
        switch (input.action) {
          case "edit": {
            const text = yield* required(input.text, "text");
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-run.edit",
              runId,
              text,
            }));
          }
          case "reorder": {
            const beforeRunId = yield* required(input.beforeRunId, "beforeRunId");
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-run.reorder",
              runId,
              beforeRunId,
            }));
          }
          case "promote_to_steer": {
            const targetRunId = yield* required(input.targetRunId, "targetRunId");
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-message.promote-to-steer",
              queuedRunId: runId,
              targetRunId,
            }));
          }
          default:
            return yield* dispatch(input.threadId, (common) => ({
              ...common,
              type: "queued-run.cancel",
              runId,
            }));
        }
      }),
    ),
  ),
  t3_thread_organize: writesThread((input) =>
    Effect.gen(function* () {
      const { threads, projection, caller } = yield* readThread(input.threadId);
      if (input.action === "move" || input.action === "unfile") {
        const folder =
          input.action === "unfile"
            ? null
            : yield* resolveThreadFolder(
                yield* required(input.folder, "folder"),
                (yield* readThreadFolders(threads)).known,
              );
        return yield* setThreadFolder(threads, projection.thread, folder);
      }
      const common = { commandId: yield* newCommandId(), threadId: projection.thread.id };
      if (input.action === "settle") {
        return yield* threads
          .settleThread({ ...common, byOwnAgent: caller?.id === projection.thread.id })
          .pipe(Effect.mapError(dispatchFailure));
      }
      let command: OrchestrationV2Command;
      switch (input.action) {
        case "snooze":
          if (input.snoozedUntil === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "snooze requires snoozedUntil.",
            });
          }
          command = { ...common, type: "thread.snooze", snoozedUntil: input.snoozedUntil };
          break;
        case "unsnooze":
        case "unsettle":
          command = { ...common, type: `thread.${input.action}`, reason: "user" };
          break;
        case "mark_unread":
          command = { ...common, type: "thread.mark-unread" };
          break;
        case "pin": {
          // Always send a key, as the client does: the reducer ignores it for a
          // thread that is already pinned, and a projection read before this
          // command can be stale if an unpin commits in between.
          const orderKey = yield* topOfPinnedRunKey(threads);
          command = { ...common, type: "thread.pin", ...(orderKey ? { orderKey } : {}) };
          break;
        }
        default:
          command = { ...common, type: `thread.${input.action}` };
      }
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  t3_folder: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const { layout, shells, known } = yield* readThreadFolders(threads);
      const refuse = (message: string) =>
        Effect.fail(new OrchestratorMcpFailure({ code: "invalid_request", message }));
      const path = Effect.fn("mcp.t3Folder.path")(function* () {
        return yield* resolveThreadFolder(yield* required(input.path, "path"), known);
      });
      const existing = Effect.fn("mcp.t3Folder.existing")(function* () {
        const value = yield* path();
        if (!known.includes(value)) return yield* refuse(`There is no folder "${value}".`);
        return value;
      });
      const existingTop = Effect.fn("mcp.t3Folder.existingTop")(function* () {
        const value = yield* existing();
        if (value.includes("/")) {
          return yield* refuse("Only a top folder can be reordered or given an icon.");
        }
        return value;
      });
      // Retags every thread under `from`; null takes them out of their folder.
      const retag = (from: string, to: (folder: string) => string | null) =>
        Effect.forEach(
          shells.filter((shell) => {
            const folder = threadFolderOf(shell.tags)?.path;
            return folder !== undefined && renameThreadFolderPath(folder, from, from) !== null;
          }),
          (shell) => setThreadFolder(threads, shell, to(threadFolderOf(shell.tags)!.path)),
          { discard: true },
        );
      let next: ReadonlyArray<SidebarFolderEntry> | null = null;
      switch (input.action) {
        case "list":
          break;
        case "create":
          next = upsertSidebarFolder(layout, yield* path());
          break;
        case "rename": {
          // Renaming onto an existing folder merges them, so a rename cut short can be repeated.
          const from = yield* existing();
          const to = yield* resolveThreadFolder(yield* required(input.to, "to"), known);
          if (to.includes("/") && known.some((candidate) => candidate.startsWith(`${from}/`))) {
            return yield* refuse("A folder with subfolders can only be renamed to a top folder.");
          }
          if (to === from || to.startsWith(`${from}/`)) {
            return yield* refuse("`to` must name a different folder outside this one.");
          }
          yield* retag(from, (folder) => renameThreadFolderPath(folder, from, to));
          next = renameSidebarFolder(upsertSidebarFolder(layout, from), from, to);
          break;
        }
        case "remove": {
          const target = yield* existing();
          yield* retag(target, () => null);
          next = removeSidebarFolder(layout, target);
          break;
        }
        case "reorder": {
          const target = yield* existingTop();
          const tops = listThreadFolders(layout, shells)
            .map((folder) => folder.path)
            .filter((candidate) => !candidate.includes("/"));
          const before =
            input.before === undefined ? null : yield* resolveThreadFolder(input.before, known);
          if (before !== null && !tops.includes(before)) {
            return yield* refuse(`\`before\` must be a top folder: ${tops.join(", ")}.`);
          }
          next = moveSidebarTopFolder(layout, tops, target, before);
          break;
        }
        case "set_icon": {
          const target = yield* existingTop();
          if (
            input.icon !== undefined &&
            !(SIDEBAR_FOLDER_ICON_NAMES as ReadonlyArray<string>).includes(input.icon)
          ) {
            return yield* refuse(`\`icon\` is one of ${SIDEBAR_FOLDER_ICON_NAMES.join(", ")}.`);
          }
          next = setSidebarFolderIcon(layout, target, input.icon ?? null);
          break;
        }
      }
      const saved =
        next === null
          ? layout
          : (yield* settings
              .updateSettings({ sidebarFolders: next })
              .pipe(Effect.mapError(unavailable))).sidebarFolders;
      const after =
        input.action === "rename" || input.action === "remove"
          ? (yield* threads.getShellSnapshot().pipe(Effect.mapError(unavailable))).threads
          : shells;
      return { folders: listThreadFolders(saved, after) };
    }),
  ),
});
