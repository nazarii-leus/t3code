import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type ContextMenuItem,
  type ContextMenuSource,
  matchKnownThreadFolder,
  parseThreadFolderPath,
  renameThreadFolderPath,
  type ScopedThreadRef,
  type SidebarFolderEntry,
  type SidebarFolderSort,
  threadFolderOf,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { readLocalApi } from "../../localApi";
import {
  moveSidebarTopFolder,
  planSidebarFolderDrop,
  removeSidebarFolder,
  renameSidebarFolder,
  setSidebarFolderIcon,
  setSidebarFolderSort,
  type SidebarUserFolder,
  upsertSidebarFolder,
} from "../../sidebarUserFolders";
import { buildMoveToFolderMenuItem, type MoveToFolderMenuId } from "../threadActionMenu.logic";
import { SIDEBAR_FOLDER_ICONS, type SidebarFolderNameEdit } from "./SidebarUserFolderHeader";

/** A folder name being typed: a new folder (top level or under `parent`), or a rename. */
export type SidebarFolderEditTarget =
  | {
      readonly kind: "new";
      readonly parent: string | null;
      readonly threads: ReadonlyArray<ScopedThreadRef>;
    }
  | { readonly kind: "rename"; readonly path: string };

type FolderMenuId =
  | "new-thread"
  | "new-subfolder"
  | "rename"
  | "show-only"
  | "move-up"
  | "move-down"
  | "move-to-top"
  | "remove"
  | `sort:${SidebarFolderSort}`
  | `icon:${string}`
  | `move-into:${string}`;

export function useSidebarFolderActions(input: {
  readonly folders: ReadonlyArray<SidebarUserFolder<EnvironmentThreadShell>>;
  readonly childrenByParentKey: ReadonlyMap<string, ReadonlyArray<EnvironmentThreadShell>>;
  /** Every listed thread, settled ones too, so a rename reaches all the app has loaded. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly layout: ReadonlyArray<SidebarFolderEntry>;
  readonly layoutWritable: boolean;
  readonly saveLayout: (next: ReadonlyArray<SidebarFolderEntry>) => void;
  readonly moveThreadToFolder: (
    target: ScopedThreadRef,
    folder: string | null,
    options?: { readonly undoable?: boolean },
  ) => Promise<unknown>;
  readonly onNewThreadInFolder: ((path: string) => void) | null;
  readonly onShowOnly: (path: string) => void;
}) {
  const gt = useGT();
  const [editTarget, setEditTarget] = useState<SidebarFolderEditTarget | null>(null);
  const [editValue, setEditValue] = useState("");

  const topPaths = input.folders.map((folder) => folder.path);
  const knownPaths = input.folders.flatMap((folder) => [
    folder.path,
    ...folder.units.flatMap((unit) => (unit.kind === "subfolder" ? [unit.path] : [])),
  ]);

  const moveThreads = (refs: ReadonlyArray<ScopedThreadRef>, path: string | null) => {
    const seen = new Set<string>();
    for (const ref of refs) {
      // A parent takes the children drawn under it along.
      const children = input.childrenByParentKey.get(scopedThreadKey(ref)) ?? [];
      for (const target of [
        ref,
        ...children.map((child) => scopeThreadRef(child.environmentId, child.id)),
      ]) {
        const key = scopedThreadKey(target);
        if (seen.has(key)) continue;
        seen.add(key);
        void input.moveThreadToFolder(target, path);
      }
    }
  };

  const retag = (map: (path: string) => string | null | undefined) => {
    for (const thread of input.threads) {
      const current = threadFolderOf(thread.source.tags)?.path;
      if (current === undefined) continue;
      const next = map(current);
      if (next === undefined) continue;
      void input.moveThreadToFolder(scopeThreadRef(thread.environmentId, thread.id), next, {
        undoable: false,
      });
    }
  };

  const renameFolder = (from: string, to: string) => {
    retag((path) => renameThreadFolderPath(path, from, to) ?? undefined);
    input.saveLayout(renameSidebarFolder(input.layout, from, to));
  };

  const startEdit = (target: SidebarFolderEditTarget, value: string) => {
    setEditTarget(target);
    setEditValue(value);
  };
  const cancelEdit = () => setEditTarget(null);
  const commitEdit = () => {
    const target = editTarget;
    setEditTarget(null);
    if (target === null) return;
    const name = editValue.trim();
    if (target.kind === "rename") {
      const parsed = parseThreadFolderPath(target.path);
      if (parsed === null || name.includes("/")) return;
      const next = parseThreadFolderPath(parsed.sub === null ? name : `${parsed.top}/${name}`);
      if (next === null || next.path === target.path || knownPaths.includes(next.path)) return;
      renameFolder(target.path, next.path);
      return;
    }
    if (target.parent !== null && name.includes("/")) return;
    const parsed = parseThreadFolderPath(
      target.parent === null ? name : `${target.parent}/${name}`,
    );
    if (parsed === null) return;
    const path = matchKnownThreadFolder(parsed.path, knownPaths);
    if (input.layoutWritable && !input.layout.some((entry) => entry.path === path)) {
      input.saveLayout(upsertSidebarFolder(input.layout, path));
    }
    if (target.threads.length > 0) moveThreads(target.threads, path);
  };
  const editFor = (target: "new-top" | `new-sub:${string}` | `rename:${string}`) => {
    if (editTarget === null) return null;
    const key =
      editTarget.kind === "rename"
        ? `rename:${editTarget.path}`
        : editTarget.parent === null
          ? "new-top"
          : `new-sub:${editTarget.parent}`;
    if (key !== target) return null;
    const edit: SidebarFolderNameEdit = {
      value: editValue,
      onChange: setEditValue,
      onCommit: commitEdit,
      onCancel: cancelEdit,
    };
    return edit;
  };

  /** The menu items behind "Move to folder" for these threads, and what to do with the pick. */
  const moveMenu = (current: string | null) =>
    buildMoveToFolderMenuItem({ paths: knownPaths, current });
  const applyMoveMenuPick = (refs: ReadonlyArray<ScopedThreadRef>, picked: MoveToFolderMenuId) => {
    if (picked === "move-to-folder:new") {
      startEdit({ kind: "new", parent: null, threads: refs }, "");
    } else if (picked === "move-to-folder:none") {
      moveThreads(refs, null);
    } else if (picked.startsWith("move-to-folder:path:")) {
      moveThreads(refs, picked.slice("move-to-folder:path:".length));
    }
  };
  const showMoveMenu = async (
    refs: ReadonlyArray<ScopedThreadRef>,
    current: string | null,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => {
    const api = readLocalApi();
    if (!api || refs.length === 0) return;
    const clicked = await settlePromise(() =>
      api.contextMenu.show(moveMenu(current).children ?? [], position, source),
    );
    if (clicked._tag === "Failure" || clicked.value === null) return;
    applyMoveMenuPick(refs, clicked.value);
  };

  const sessionCount = (path: string) =>
    input.threads.filter((thread) => {
      const folder = threadFolderOf(thread.source.tags)?.path;
      return folder !== undefined && renameThreadFolderPath(folder, path, path) !== null;
    }).length;

  const applyDrop = (from: string, to: string, zone: "before" | "after" | "into") => {
    const plan = planSidebarFolderDrop({
      layout: input.layout,
      knownPaths,
      displayedTops: topPaths,
      from,
      to,
      zone,
      unitKeysOf: (path) =>
        input.folders.find((folder) => folder.path === path)?.units.map((unit) => unit.key) ?? [],
    });
    if (plan === null) return false;
    if (plan.rename !== null) {
      const { from: renamedFrom, to: renamedTo } = plan.rename;
      retag((path) => renameThreadFolderPath(path, renamedFrom, renamedTo) ?? undefined);
    }
    input.saveLayout(plan.layout);
    return true;
  };

  const openFolderMenu = useStableCallback(
    (path: string, position: { x: number; y: number }, source: ContextMenuSource) => {
      void (async () => {
        const api = readLocalApi();
        const parsed = parseThreadFolderPath(path);
        if (!api || parsed === null) return;
        const isTop = parsed.sub === null;
        const entry = input.layout.find((candidate) => candidate.path === path);
        const sort = entry?.sort ?? "created";
        const hasSubfolders = knownPaths.some((known) => known.startsWith(`${path}/`));
        const topIndex = topPaths.indexOf(path);
        const writable = input.layoutWritable;
        const items: ContextMenuItem<FolderMenuId>[] = [
          ...(input.onNewThreadInFolder
            ? [{ id: "new-thread" as const, label: gt("New thread here") }]
            : []),
          ...(isTop
            ? [{ id: "new-subfolder" as const, label: gt("New subfolder…"), disabled: !writable }]
            : []),
          { id: "rename", label: gt("Rename…"), separatorBefore: true },
          {
            id: `sort:${sort}`,
            label: gt("Sort by"),
            disabled: !writable,
            children: (
              [
                ["created", gt("Created")],
                ["title", gt("Title")],
                ["manual", gt("My order")],
              ] as const
            ).map(([value, label]) => ({
              id: `sort:${value}` as const,
              label,
              checked: sort === value,
            })),
          },
          ...(isTop
            ? [
                {
                  id: "icon:" as const,
                  label: gt("Icon"),
                  disabled: !writable,
                  children: [
                    { id: "icon:" as const, label: gt("None"), checked: entry?.icon === undefined },
                    ...Object.keys(SIDEBAR_FOLDER_ICONS).map((name) => ({
                      id: `icon:${name}` as const,
                      label: name,
                      checked: entry?.icon === name,
                    })),
                  ],
                },
              ]
            : []),
          { id: "show-only", label: gt("Show only this folder") },
          ...(isTop
            ? [
                {
                  id: "move-up" as const,
                  label: gt("Move up"),
                  disabled: !writable || topIndex <= 0,
                  separatorBefore: true,
                },
                {
                  id: "move-down" as const,
                  label: gt("Move down"),
                  disabled: !writable || topIndex < 0 || topIndex >= topPaths.length - 1,
                },
                ...(hasSubfolders
                  ? []
                  : [
                      {
                        id: "move-into:" as const,
                        label: gt("Move into"),
                        disabled: topPaths.length < 2,
                        children: topPaths
                          .filter((top) => top !== path)
                          .map((top) => ({ id: `move-into:${top}` as const, label: top })),
                      },
                    ]),
              ]
            : [
                {
                  id: "move-to-top" as const,
                  label: gt("Move to top level"),
                  separatorBefore: true,
                },
              ]),
          { id: "remove", label: gt("Remove folder"), destructive: true, separatorBefore: true },
        ];
        const clicked = await settlePromise(() => api.contextMenu.show(items, position, source));
        if (clicked._tag === "Failure" || clicked.value === null) return;
        const picked = clicked.value;
        if (picked.startsWith("sort:")) {
          input.saveLayout(
            setSidebarFolderSort(input.layout, path, picked.slice(5) as SidebarFolderSort),
          );
          return;
        }
        if (picked.startsWith("icon:")) {
          const icon = picked.slice(5);
          input.saveLayout(setSidebarFolderIcon(input.layout, path, icon === "" ? null : icon));
          return;
        }
        if (picked.startsWith("move-into:")) {
          applyDrop(path, picked.slice("move-into:".length), "into");
          return;
        }
        switch (picked) {
          case "new-thread":
            input.onNewThreadInFolder?.(path);
            return;
          case "new-subfolder":
            startEdit({ kind: "new", parent: path, threads: [] }, "");
            return;
          case "rename":
            startEdit({ kind: "rename", path }, parsed.sub ?? parsed.top);
            return;
          case "show-only":
            input.onShowOnly(parsed.top);
            return;
          case "move-up":
            input.saveLayout(
              moveSidebarTopFolder(input.layout, topPaths, path, topPaths[topIndex - 1] ?? null),
            );
            return;
          case "move-down":
            input.saveLayout(
              moveSidebarTopFolder(input.layout, topPaths, path, topPaths[topIndex + 2] ?? null),
            );
            return;
          case "move-to-top": {
            const last = topPaths.at(-1);
            if (last !== undefined) applyDrop(path, last, "after");
            return;
          }
          case "remove": {
            const count = sessionCount(path);
            if (
              count > 0 &&
              !(await api.dialogs.confirm(
                gt('Remove folder "{folder}"? Its threads go back to their projects.', {
                  folder: path,
                }),
              ))
            ) {
              return;
            }
            retag((current) =>
              renameThreadFolderPath(current, path, path) === null ? undefined : null,
            );
            if (input.layoutWritable) input.saveLayout(removeSidebarFolder(input.layout, path));
            return;
          }
        }
      })();
    },
  );

  return {
    knownPaths,
    editTarget,
    editFor,
    moveThreads,
    moveMenu,
    applyMoveMenuPick,
    showMoveMenu,
    startNewFolder: (threads: ReadonlyArray<ScopedThreadRef>) =>
      startEdit({ kind: "new", parent: null, threads }, ""),
    openFolderMenu,
    applyDrop,
  };
}
