import {
  parseThreadFolderPath,
  renameThreadFolderPath,
  type SidebarFolderEntry,
  type SidebarFolderSort,
  threadFolderOf,
  threadParentTagOf,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

export type SidebarAttentionClass = "needsYou" | "failed" | "done" | "working" | "waiting" | "idle";

export interface SidebarFolderCounts {
  readonly needsYou: number;
  readonly failed: number;
  readonly done: number;
  readonly working: number;
  readonly total: number;
}

export interface SidebarSessionNode<T> {
  readonly thread: T;
  readonly children: ReadonlyArray<T>;
}

export type SidebarFolderUnit<T> =
  | { readonly kind: "session"; readonly key: string; readonly session: SidebarSessionNode<T> }
  | {
      readonly kind: "subfolder";
      readonly key: string;
      readonly path: string;
      readonly name: string;
      readonly sessions: ReadonlyArray<SidebarSessionNode<T>>;
      readonly counts: SidebarFolderCounts;
    };

export interface SidebarUserFolder<T> {
  readonly path: string;
  readonly name: string;
  readonly icon: string | null;
  readonly sort: SidebarFolderSort;
  readonly units: ReadonlyArray<SidebarFolderUnit<T>>;
  readonly counts: SidebarFolderCounts;
}

export type SidebarFolderThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "title" | "createdAt" | "lineage"
> & { readonly source: { readonly tags?: ReadonlyArray<string> | undefined } };

const MAX_PARENT_HOPS = 8;
const EMPTY_COUNTS: SidebarFolderCounts = { needsYou: 0, failed: 0, done: 0, working: 0, total: 0 };

const threadKeyOf = (thread: Pick<SidebarFolderThread, "environmentId" | "id">) =>
  `${thread.environmentId}:${thread.id}`;

const compareNames = (left: string, right: string) =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });

/** A fork names its parent in its lineage; a fresh sub-session in a `parent:` tag. */
function effectiveParentKey(thread: SidebarFolderThread): string | null {
  const parentId =
    thread.lineage.relationshipToParent === "fork"
      ? thread.lineage.parentThreadId
      : threadParentTagOf(thread.source.tags);
  return parentId === null ? null : `${thread.environmentId}:${parentId}`;
}

function addCounts<T>(
  counts: SidebarFolderCounts,
  threads: ReadonlyArray<T>,
  classOf: (thread: T) => SidebarAttentionClass,
): SidebarFolderCounts {
  const next = { ...counts };
  for (const thread of threads) {
    const cls = classOf(thread);
    if (cls === "needsYou" || cls === "failed" || cls === "done" || cls === "working") {
      next[cls] += 1;
    }
    next.total += 1;
  }
  return next;
}

function sortItems<I>(
  items: ReadonlyArray<I>,
  entry: SidebarFolderEntry | undefined,
  keyOf: (item: I) => string,
  titleOf: (item: I) => string,
  createdOf: (item: I) => string | null,
): I[] {
  const byCreation = (left: I, right: I) => {
    const leftCreated = createdOf(left);
    const rightCreated = createdOf(right);
    if (leftCreated !== rightCreated) {
      if (leftCreated === null) return 1;
      if (rightCreated === null) return -1;
      return leftCreated < rightCreated ? -1 : 1;
    }
    return keyOf(left) < keyOf(right) ? -1 : keyOf(left) > keyOf(right) ? 1 : 0;
  };
  const sort = entry?.sort ?? "created";
  if (sort === "title") {
    return items.toSorted(
      (left, right) => compareNames(titleOf(left), titleOf(right)) || byCreation(left, right),
    );
  }
  if (sort === "manual") {
    const index = new Map((entry?.order ?? []).map((key, position) => [key, position] as const));
    return items.toSorted((left, right) => {
      const leftIndex = index.get(keyOf(left)) ?? Number.POSITIVE_INFINITY;
      const rightIndex = index.get(keyOf(right)) ?? Number.POSITIVE_INFINITY;
      return leftIndex !== rightIndex ? leftIndex - rightIndex : byCreation(left, right);
    });
  }
  return items.toSorted(byCreation);
}

/**
 * The user's folders above the project folders. Children (forks and sub-sessions)
 * sit under their top parent wherever they are filed; roots go to their folder or,
 * when unfiled, back to their project.
 */
export function buildSidebarUserFolders<T extends SidebarFolderThread>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly layout: ReadonlyArray<SidebarFolderEntry>;
  readonly classOf: (thread: T) => SidebarAttentionClass;
}): {
  readonly folders: ReadonlyArray<SidebarUserFolder<T>>;
  readonly unfiledRoots: ReadonlyArray<T>;
  readonly childrenByParentKey: ReadonlyMap<string, ReadonlyArray<T>>;
} {
  const byKey = new Map(input.threads.map((thread) => [threadKeyOf(thread), thread] as const));
  const topParentKey = (thread: T): string | null => {
    let top: string | null = null;
    const seen = new Set([threadKeyOf(thread)]);
    let current: T | undefined = thread;
    for (let hop = 0; hop < MAX_PARENT_HOPS && current !== undefined; hop += 1) {
      const parentKey = effectiveParentKey(current);
      if (parentKey === null || !byKey.has(parentKey)) break;
      // A cycle has no top; its threads stay roots.
      if (seen.has(parentKey)) return null;
      seen.add(parentKey);
      top = parentKey;
      current = byKey.get(parentKey);
    }
    return top;
  };

  const roots: T[] = [];
  const children = new Map<string, T[]>();
  for (const thread of input.threads) {
    const top = topParentKey(thread);
    if (top === null) roots.push(thread);
    else children.set(top, [...(children.get(top) ?? []), thread]);
  }
  const childrenByParentKey = new Map(
    [...children].map(
      ([key, list]) =>
        [key, list.toSorted((left, right) => (left.createdAt < right.createdAt ? -1 : 1))] as const,
    ),
  );
  const nodeOf = (thread: T): SidebarSessionNode<T> => ({
    thread,
    children: childrenByParentKey.get(threadKeyOf(thread)) ?? [],
  });
  const countNodes = (nodes: ReadonlyArray<SidebarSessionNode<T>>) =>
    addCounts(
      EMPTY_COUNTS,
      nodes.flatMap((node) => [node.thread, ...node.children]),
      input.classOf,
    );

  const entryByPath = new Map<string, SidebarFolderEntry>();
  const layoutTops: string[] = [];
  const subfolderNamesByTop = new Map<string, Set<string>>();
  const addSubfolder = (top: string, sub: string) =>
    subfolderNamesByTop.set(top, (subfolderNamesByTop.get(top) ?? new Set()).add(sub));
  for (const entry of input.layout) {
    const parsed = parseThreadFolderPath(entry.path);
    if (parsed === null || entryByPath.has(parsed.path)) continue;
    entryByPath.set(parsed.path, entry);
    if (!layoutTops.includes(parsed.top)) layoutTops.push(parsed.top);
    if (parsed.sub !== null) addSubfolder(parsed.top, parsed.sub);
  }

  const unfiledRoots: T[] = [];
  const rootsByPath = new Map<string, T[]>();
  for (const thread of roots) {
    const folder = threadFolderOf(thread.source.tags);
    if (folder === null) {
      unfiledRoots.push(thread);
      continue;
    }
    rootsByPath.set(folder.path, [...(rootsByPath.get(folder.path) ?? []), thread]);
    if (folder.sub !== null) addSubfolder(folder.top, folder.sub);
  }
  const taggedTops = [...rootsByPath.keys()].map((path) => path.split("/")[0]!);
  const tops = [
    ...layoutTops,
    ...[...new Set(taggedTops)].filter((top) => !layoutTops.includes(top)).toSorted(compareNames),
  ];

  const folders = tops.map((top): SidebarUserFolder<T> => {
    const topEntry = entryByPath.get(top);
    const sessionUnits: SidebarFolderUnit<T>[] = (rootsByPath.get(top) ?? []).map((thread) => ({
      kind: "session",
      key: thread.id,
      session: nodeOf(thread),
    }));
    const subfolderUnits = [...(subfolderNamesByTop.get(top) ?? [])].map(
      (name): SidebarFolderUnit<T> => {
        const path = `${top}/${name}`;
        const sessions = sortItems(
          (rootsByPath.get(path) ?? []).map(nodeOf),
          entryByPath.get(path),
          (node) => node.thread.id,
          (node) => node.thread.title,
          (node) => node.thread.createdAt,
        );
        return {
          kind: "subfolder",
          key: `/${name}`,
          path,
          name,
          sessions,
          counts: countNodes(sessions),
        };
      },
    );
    const units = sortItems(
      [...sessionUnits, ...subfolderUnits],
      topEntry,
      (unit) => unit.key,
      (unit) => (unit.kind === "session" ? unit.session.thread.title : unit.name),
      (unit) =>
        unit.kind === "session"
          ? unit.session.thread.createdAt
          : (unit.sessions.map((node) => node.thread.createdAt).toSorted()[0] ?? null),
    );
    return {
      path: top,
      name: top,
      icon: topEntry?.icon ?? null,
      sort: topEntry?.sort ?? "created",
      units,
      counts: countNodes(
        units.flatMap((unit) => (unit.kind === "session" ? [unit.session] : unit.sessions)),
      ),
    };
  });

  return {
    folders,
    unfiledRoots: unfiledRoots.toSorted((left, right) =>
      left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0,
    ),
    childrenByParentKey,
  };
}

const ATTENTION_TIERS = ["needsYou", "failed", "done"] as const;

/** F8: the next thread in the most urgent tier that has one besides the current thread. */
export function resolveAdjacentAttentionKey(input: {
  readonly orderedKeys: ReadonlyArray<string>;
  readonly classByKey: ReadonlyMap<string, SidebarAttentionClass>;
  readonly currentKey: string | null;
  readonly direction: "next" | "previous";
}): string | null {
  const position = input.currentKey === null ? -1 : input.orderedKeys.indexOf(input.currentKey);
  for (const tier of ATTENTION_TIERS) {
    const candidates = input.orderedKeys.filter(
      (key) => key !== input.currentKey && input.classByKey.get(key) === tier,
    );
    if (candidates.length === 0) continue;
    const indexOf = (key: string) => input.orderedKeys.indexOf(key);
    if (input.direction === "next") {
      return candidates.find((key) => indexOf(key) > position) ?? candidates[0]!;
    }
    const before = candidates.filter((key) => position < 0 || indexOf(key) < position);
    return before.at(-1) ?? candidates.at(-1)!;
  }
  return null;
}

type Layout = ReadonlyArray<SidebarFolderEntry>;

const updateEntry = (
  layout: Layout,
  path: string,
  update: (entry: SidebarFolderEntry) => SidebarFolderEntry,
): Layout =>
  upsertSidebarFolder(layout, path).map((entry) => (entry.path === path ? update(entry) : entry));

/** Adds the folder (and its top folder) when missing. */
export function upsertSidebarFolder(layout: Layout, path: string): Layout {
  const parsed = parseThreadFolderPath(path);
  if (parsed === null) return layout;
  const next = [...layout];
  if (!next.some((entry) => entry.path === parsed.top)) next.push({ path: parsed.top });
  if (parsed.sub !== null && !next.some((entry) => entry.path === parsed.path)) {
    next.push({ path: parsed.path });
  }
  return next;
}

const withoutOrderKey = (entry: SidebarFolderEntry, key: string): SidebarFolderEntry =>
  entry.order === undefined || !entry.order.includes(key)
    ? entry
    : { ...entry, order: entry.order.filter((candidate) => candidate !== key) };

/** Removes the folder, its subfolders, and its place in its parent's saved order. */
export function removeSidebarFolder(layout: Layout, path: string): Layout {
  const parsed = parseThreadFolderPath(path);
  return layout
    .filter((entry) => renameThreadFolderPath(entry.path, path, path) === null)
    .map((entry) =>
      parsed?.sub != null && entry.path === parsed.top
        ? withoutOrderKey(entry, `/${parsed.sub}`)
        : entry,
    );
}

/** Renames the folder and its subfolders; an entry that would clash with an existing one drops. */
export function renameSidebarFolder(layout: Layout, from: string, to: string): Layout {
  const source = parseThreadFolderPath(from);
  const target = parseThreadFolderPath(to);
  const existing = new Set(layout.map((entry) => entry.path));
  const moved = layout.flatMap((entry) => {
    const renamed = renameThreadFolderPath(entry.path, from, to);
    if (renamed === null) return [entry];
    return existing.has(renamed) ? [] : [{ ...entry, path: renamed }];
  });
  if (source?.sub == null) return moved;
  return moved.map((entry) => {
    if (entry.path !== source.top || entry.order === undefined) return entry;
    return target?.sub != null && target.top === source.top
      ? {
          ...entry,
          order: entry.order.map((key) => (key === `/${source.sub}` ? `/${target.sub}` : key)),
        }
      : withoutOrderKey(entry, `/${source.sub}`);
  });
}

/** Saves every drawn top folder in order, with `path` moved before `beforePath` or last. */
export function moveSidebarTopFolder(
  layout: Layout,
  displayedTops: ReadonlyArray<string>,
  path: string,
  beforePath: string | null,
): Layout {
  const order = displayedTops.filter((top) => top !== path);
  const index = beforePath === null ? -1 : order.indexOf(beforePath);
  order.splice(index < 0 ? order.length : index, 0, path);
  const entryOf = (top: string) => layout.find((entry) => entry.path === top) ?? { path: top };
  return [...order.map(entryOf), ...layout.filter((entry) => !order.includes(entry.path))];
}

/** Saves the drawn units of a folder in order, with `unitKey` placed next to `anchorKey`. */
export function placeSidebarFolderUnit(
  layout: Layout,
  folderPath: string,
  displayedUnitKeys: ReadonlyArray<string>,
  unitKey: string,
  anchorKey: string,
  side: "before" | "after",
): Layout {
  const order = displayedUnitKeys.filter((key) => key !== unitKey);
  const anchor = order.indexOf(anchorKey);
  order.splice(anchor < 0 ? order.length : anchor + (side === "after" ? 1 : 0), 0, unitKey);
  return updateEntry(layout, folderPath, (entry) => ({ ...entry, sort: "manual", order }));
}

export function setSidebarFolderIcon(layout: Layout, path: string, icon: string | null): Layout {
  return updateEntry(layout, path, ({ icon: _icon, ...entry }) =>
    icon === null ? entry : { ...entry, icon },
  );
}

export function setSidebarFolderSort(
  layout: Layout,
  path: string,
  sort: SidebarFolderSort,
): Layout {
  return updateEntry(layout, path, (entry) => ({ ...entry, sort }));
}

/**
 * A folder heading dropped on another heading: reorder, nest under a top folder, or
 * lift a subfolder to the top. Null when the drop would need a third level, clash
 * with an existing folder or change nothing.
 */
export function planSidebarFolderDrop(input: {
  readonly layout: Layout;
  readonly knownPaths: ReadonlyArray<string>;
  readonly displayedTops: ReadonlyArray<string>;
  readonly from: string;
  readonly to: string;
  readonly zone: "before" | "after" | "into";
  readonly unitKeysOf?: (folderPath: string) => ReadonlyArray<string>;
}): { readonly rename: { from: string; to: string } | null; readonly layout: Layout } | null {
  const from = parseThreadFolderPath(input.from);
  const to = parseThreadFolderPath(input.to);
  if (from === null || to === null || from.path === to.path) return null;
  const known = new Set(input.knownPaths);
  const hasSubfolders = input.knownPaths.some((path) => path.startsWith(`${from.path}/`));

  if (to.sub !== null) {
    if (input.zone === "into" || from.sub === null || from.top !== to.top) return null;
    const parent = input.layout.find((entry) => entry.path === to.top);
    if (parent?.sort !== "manual" || input.unitKeysOf === undefined) return null;
    return {
      rename: null,
      layout: placeSidebarFolderUnit(
        input.layout,
        to.top,
        input.unitKeysOf(to.top),
        `/${from.sub}`,
        `/${to.sub}`,
        input.zone,
      ),
    };
  }

  if (input.zone === "into") {
    if (hasSubfolders || from.top === to.top) return null;
    const target = `${to.top}/${from.sub ?? from.top}`;
    if (known.has(target)) return null;
    return {
      rename: { from: from.path, to: target },
      layout: renameSidebarFolder(input.layout, from.path, target),
    };
  }

  const lifted = from.sub === null ? null : from.sub;
  if (lifted !== null && known.has(lifted)) return null;
  const movedPath = lifted ?? from.path;
  const tops = input.displayedTops;
  const targetIndex = tops.indexOf(to.top);
  const beforePath =
    input.zone === "before"
      ? to.top
      : (tops.slice(targetIndex + 1).find((top) => top !== movedPath) ?? null);
  const renamedLayout =
    lifted === null ? input.layout : renameSidebarFolder(input.layout, from.path, lifted);
  return {
    rename: lifted === null ? null : { from: from.path, to: lifted },
    layout: moveSidebarTopFolder(renamedLayout, tops, movedPath, beforePath),
  };
}
