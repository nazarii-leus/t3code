import {
  matchKnownThreadFolder,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  parseThreadFolderPath,
  planThreadFolderTagChanges,
  type SidebarFolderEntry,
  type ThreadId,
  threadFolderOf,
  threadFolderTag,
  threadParentTag,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { dispatchFailure, newCommandId, unavailable } from "./threadAccess.ts";

type Threads = Pick<
  ThreadManagement.ThreadManagementService["Service"],
  "dispatch" | "getShellSnapshot"
>;

/** Every folder the sidebar shows: saved in the layout, or named by a thread's tag. */
export function knownThreadFolders(
  shells: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "tags">>,
  layout: ReadonlyArray<SidebarFolderEntry>,
): string[] {
  const paths = new Set<string>();
  for (const entry of layout) {
    const parsed = parseThreadFolderPath(entry.path);
    if (parsed !== null) paths.add(parsed.path);
  }
  for (const shell of shells) {
    const folder = threadFolderOf(shell.tags);
    if (folder !== null) paths.add(folder.path);
  }
  return [...paths];
}

export const readThreadFolders = Effect.fn("ThreadFolders.read")(function* (threads: Threads) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const layout = (yield* settings.getSettings.pipe(Effect.mapError(unavailable))).sidebarFolders;
  const shells = (yield* threads.getShellSnapshot().pipe(Effect.mapError(unavailable))).threads;
  return { layout, shells, known: knownThreadFolders(shells, layout) };
});

/** An agent's folder name, in an existing folder's spelling when one matches ignoring case. */
export const resolveThreadFolder = (
  input: string,
  known: ReadonlyArray<string>,
): Effect.Effect<string, OrchestratorMcpFailure> => {
  const parsed = parseThreadFolderPath(input);
  return parsed === null
    ? Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "A folder is `Top` or `Top/Sub`, with at most 60 characters in each part.",
        }),
      )
    : Effect.succeed(matchKnownThreadFolder(parsed.path, known));
};

/** The tags a launched thread is born with: its folder, and its parent when it asked for one. */
export const threadCreationTags = Effect.fn("ThreadFolders.creationTags")(function* (input: {
  readonly folder?: string | undefined;
  readonly parent?: "self" | undefined;
  readonly caller: Pick<OrchestrationV2ThreadShell, "id" | "tags"> | undefined;
  readonly known: ReadonlyArray<string>;
}) {
  if (input.parent === "self" && input.caller === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: '`parent: "self"` needs a calling thread.',
    });
  }
  const folder =
    input.folder !== undefined
      ? yield* resolveThreadFolder(input.folder, input.known)
      : input.parent === "self"
        ? (threadFolderOf(input.caller?.tags)?.path ?? null)
        : null;
  return [
    ...(input.parent === "self" && input.caller ? [threadParentTag(input.caller.id)] : []),
    ...(folder === null ? [] : [threadFolderTag(folder)]),
  ];
});

/** Adds the new folder tag before removing the old ones, so the thread is never shown unfiled. */
export const setThreadFolder = Effect.fn("ThreadFolders.setFolder")(function* (
  threads: Pick<Threads, "dispatch">,
  thread: { readonly id: ThreadId; readonly tags?: ReadonlyArray<string> | undefined },
  folder: string | null,
) {
  let sequence = 0;
  for (const change of planThreadFolderTagChanges(thread.tags ?? [], folder)) {
    const result = yield* threads
      .dispatch({
        type: "thread.tag.set",
        commandId: yield* newCommandId(),
        threadId: thread.id,
        ...change,
      })
      .pipe(Effect.mapError(dispatchFailure));
    sequence = result.sequence;
  }
  return { sequence };
});
