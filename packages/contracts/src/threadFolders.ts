import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/**
 * Sidebar folders are thread tags, so they need no server state of their own:
 * `in:<Top>` or `in:<Top>/<Sub>` files a thread, `parent:<threadId>` lists a fresh
 * sub-session under the thread that started it.
 */
const THREAD_FOLDER_TAG_PREFIX = "in:";
const THREAD_PARENT_TAG_PREFIX = "parent:";
const THREAD_FOLDER_SEGMENT_MAX = 60;

export interface ThreadFolderPath {
  readonly path: string;
  readonly top: string;
  readonly sub: string | null;
}

const isValidSegment = (segment: string) =>
  segment.length > 0 && segment.length <= THREAD_FOLDER_SEGMENT_MAX && !/\p{Cc}/u.test(segment);

/** Null when empty, deeper than two segments, over the length limit, or with a control character. */
export function parseThreadFolderPath(input: string): ThreadFolderPath | null {
  const segments = input.split("/").map((segment) => segment.trim());
  if (segments.length > 2 || !segments.every(isValidSegment)) return null;
  const [top, sub = null] = segments as [string, string?];
  return { path: sub === null ? top : `${top}/${sub}`, top, sub };
}

export const threadFolderTag = (path: string) => `${THREAD_FOLDER_TAG_PREFIX}${path}`;
export const threadParentTag = (threadId: string) => `${THREAD_PARENT_TAG_PREFIX}${threadId}`;

/** A move adds the new tag before removing the old one, so the last valid tag is the folder. */
export function threadFolderOf(tags: ReadonlyArray<string> | undefined): ThreadFolderPath | null {
  for (let index = (tags?.length ?? 0) - 1; index >= 0; index -= 1) {
    const tag = tags![index]!;
    if (!tag.startsWith(THREAD_FOLDER_TAG_PREFIX)) continue;
    const folder = parseThreadFolderPath(tag.slice(THREAD_FOLDER_TAG_PREFIX.length));
    if (folder !== null) return folder;
  }
  return null;
}

export function threadParentTagOf(tags: ReadonlyArray<string> | undefined): string | null {
  for (let index = (tags?.length ?? 0) - 1; index >= 0; index -= 1) {
    const tag = tags![index]!;
    if (tag.startsWith(THREAD_PARENT_TAG_PREFIX) && tag.length > THREAD_PARENT_TAG_PREFIX.length) {
      return tag.slice(THREAD_PARENT_TAG_PREFIX.length);
    }
  }
  return null;
}

/** Adds the new folder tag first, then removes every other folder tag. Empty when nothing changes. */
export function planThreadFolderTagChanges(
  tags: ReadonlyArray<string>,
  path: string | null,
): ReadonlyArray<{ readonly tag: string; readonly tagged: boolean }> {
  const target = path === null ? null : threadFolderTag(path);
  const folderTags = tags.filter((tag) => tag.startsWith(THREAD_FOLDER_TAG_PREFIX));
  if (target !== null && folderTags.length === 1 && folderTags[0] === target) return [];
  return [
    ...(target !== null && !folderTags.includes(target) ? [{ tag: target, tagged: true }] : []),
    ...folderTags.filter((tag) => tag !== target).map((tag) => ({ tag, tagged: false })),
  ];
}

/** The tags after a move: the same as applying `planThreadFolderTagChanges` in order. */
export function withThreadFolderTag(tags: ReadonlyArray<string>, path: string | null): string[] {
  return [
    ...tags.filter((tag) => !tag.startsWith(THREAD_FOLDER_TAG_PREFIX)),
    ...(path === null ? [] : [threadFolderTag(path)]),
  ];
}

/** `from` itself or anything under it, moved to `to`; null when `path` is not under `from`. */
export function renameThreadFolderPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : null;
}

/** The spelling of an existing folder that equals `path` ignoring case, segment by segment. */
export function matchKnownThreadFolder(path: string, known: ReadonlyArray<string>): string {
  const same = (left: string, right: string) =>
    left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
  const exact = known.find((candidate) => same(candidate, path));
  if (exact !== undefined) return exact;
  const [top, ...rest] = path.split("/");
  const knownTop = known
    .map((candidate) => candidate.split("/")[0]!)
    .find((candidate) => same(candidate, top!));
  return knownTop === undefined ? path : [knownTop, ...rest].join("/");
}

/** Icons a top folder can show; the sidebar draws one per name. */
export const SIDEBAR_FOLDER_ICON_NAMES = [
  "folder",
  "users",
  "briefcase",
  "building",
  "list-checks",
  "inbox",
  "star",
  "flag",
  "bug",
  "wrench",
  "rocket",
  "book",
] as const;
export type SidebarFolderIconName = (typeof SIDEBAR_FOLDER_ICON_NAMES)[number];

export const SidebarFolderSort = Schema.Literals(["created", "title", "manual"]);
export type SidebarFolderSort = typeof SidebarFolderSort.Type;

export const SidebarFolderEntry = Schema.Struct({
  path: Schema.String,
  icon: Schema.optionalKey(Schema.String),
  sort: Schema.optionalKey(SidebarFolderSort),
  /** Thread ids, or `/<name>` for a subfolder; read only with sort `manual`. */
  order: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type SidebarFolderEntry = typeof SidebarFolderEntry.Type;

const isSidebarFolderEntry = Schema.is(SidebarFolderEntry);

/** Folder order, icons and sort. Bad entries drop alone, so a hand edit cannot reset settings. */
export const SidebarFolderLayout = Schema.Array(Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.Array(SidebarFolderEntry),
    SchemaTransformation.transform<ReadonlyArray<SidebarFolderEntry>, ReadonlyArray<unknown>>({
      decode: (values) => values.filter(isSidebarFolderEntry),
      encode: (values) => values,
    }),
  ),
  Schema.withDecodingDefault(Effect.succeed([])),
);

// Folder layout edits, shared by the sidebar and the agents' `t3_folder` tool.
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
