import { EnvironmentId, type SidebarFolderEntry, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarUserFolders,
  flattenSidebarUserFolders,
  moveSidebarTopFolder,
  placeSidebarFolderUnit,
  planSidebarFolderDrop,
  removeSidebarFolder,
  renameSidebarFolder,
  resolveAdjacentAttentionKey,
  setSidebarFolderIcon,
  setSidebarFolderSort,
  type SidebarAttentionClass,
  type SidebarFolderUnit,
  upsertSidebarFolder,
} from "./sidebarUserFolders";

const ENV = EnvironmentId.make("local");

interface TestThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  readonly createdAt: string;
  readonly lineage: {
    readonly parentThreadId: ThreadId | null;
    readonly relationshipToParent: "fork" | "subagent" | null;
    readonly rootThreadId: ThreadId;
  };
  readonly source: { readonly tags?: ReadonlyArray<string> };
  readonly cls: SidebarAttentionClass;
}

function thread(
  id: string,
  minute: number,
  options: {
    tags?: ReadonlyArray<string>;
    forkOf?: string;
    title?: string;
    cls?: SidebarAttentionClass;
  } = {},
): TestThread {
  return {
    environmentId: ENV,
    id: ThreadId.make(id),
    title: options.title ?? id,
    createdAt: `2026-11-19T10:${String(minute).padStart(2, "0")}:00.000Z`,
    lineage: {
      parentThreadId: options.forkOf === undefined ? null : ThreadId.make(options.forkOf),
      relationshipToParent: options.forkOf === undefined ? null : "fork",
      rootThreadId: ThreadId.make(options.forkOf ?? id),
    },
    source: { tags: options.tags ?? [] },
    cls: options.cls ?? "idle",
  };
}

function build(threads: ReadonlyArray<TestThread>, layout: ReadonlyArray<SidebarFolderEntry> = []) {
  return buildSidebarUserFolders({ threads, layout, classOf: (entry) => entry.cls });
}

function describeUnit(unit: SidebarFolderUnit<TestThread>): string {
  const session = (node: { thread: TestThread; children: ReadonlyArray<TestThread> }) =>
    node.children.length === 0
      ? node.thread.id
      : `${node.thread.id}(${node.children.map((child) => child.id).join(",")})`;
  return unit.kind === "session"
    ? session(unit.session)
    : `${unit.name}[${unit.sessions.map(session).join(",")}]`;
}

function summarize(result: ReturnType<typeof build>) {
  return {
    folders: result.folders.map(
      (folder) => `${folder.path}: ${folder.units.map(describeUnit).join(" ")}`,
    ),
    unfiled: result.unfiledRoots.map((entry) => entry.id),
  };
}

describe("buildSidebarUserFolders", () => {
  it("files roots by their last folder tag and leaves the rest to their projects", () => {
    const result = build([
      thread("a", 1, { tags: ["in:Team", "in:Tasks"] }),
      thread("b", 2, { tags: ["in:Tasks/TASK-1"] }),
      thread("c", 3, { tags: ["in:A/B/C"] }),
      thread("d", 4),
    ]);
    expect(summarize(result)).toEqual({
      folders: ["Tasks: a TASK-1[b]"],
      unfiled: ["c", "d"],
    });
  });

  it("nests forks and sub-sessions under their top parent, wherever they are filed", () => {
    const result = build([
      thread("parent", 1, { tags: ["in:Tasks"] }),
      thread("fork", 3, { forkOf: "parent" }),
      thread("sub", 2, { tags: ["parent:parent", "in:Team"] }),
      thread("grandchild", 4, { tags: ["parent:sub"] }),
      thread("orphan", 5, { tags: ["parent:settled-elsewhere", "in:Team"] }),
    ]);
    expect(summarize(result)).toEqual({
      folders: ["Tasks: parent(sub,fork,grandchild)", "Team: orphan"],
      unfiled: [],
    });
    expect(result.childrenByParentKey.size).toBe(1);
  });

  it("ends a parent cycle by keeping both threads as roots", () => {
    const result = build([
      thread("a", 1, { tags: ["parent:b"] }),
      thread("b", 2, { tags: ["parent:a"] }),
    ]);
    expect(summarize(result).unfiled).toEqual(["a", "b"]);
  });

  it("orders units by creation, a subfolder by its oldest session, an empty one last", () => {
    const result = build(
      [
        thread("late", 9, { tags: ["in:Tasks"] }),
        thread("sub-new", 8, { tags: ["in:Tasks/Sub"] }),
        thread("sub-old", 2, { tags: ["in:Tasks/Sub"] }),
        thread("early", 1, { tags: ["in:Tasks"] }),
      ],
      [{ path: "Tasks/Empty" }],
    );
    expect(summarize(result).folders).toEqual(["Tasks: early Sub[sub-old,sub-new] late Empty[]"]);
  });

  it("sorts by title or by the saved order when the folder asks for it", () => {
    const threads = [
      thread("t1", 1, { tags: ["in:Tasks"], title: "Task 10" }),
      thread("t2", 2, { tags: ["in:Tasks"], title: "task 9" }),
      thread("t3", 3, { tags: ["in:Tasks/Zed"] }),
    ];
    expect(summarize(build(threads, [{ path: "Tasks", sort: "title" }])).folders).toEqual([
      "Tasks: t2 t1 Zed[t3]",
    ]);
    expect(
      summarize(build(threads, [{ path: "Tasks", sort: "manual", order: ["/Zed", "t2", "gone"] }]))
        .folders,
    ).toEqual(["Tasks: Zed[t3] t2 t1"]);
  });

  it("orders folders as saved, then the unsaved ones by name, and keeps saved empty ones", () => {
    const result = build(
      [thread("a", 1, { tags: ["in:Zoo"] }), thread("b", 2, { tags: ["in:Apple/X"] })],
      [{ path: "Team", icon: "users" }, { path: "Zoo" }],
    );
    expect(result.folders.map((folder) => [folder.path, folder.icon])).toEqual([
      ["Team", "users"],
      ["Zoo", null],
      ["Apple", null],
    ]);
  });

  it("counts every thread under a folder by class", () => {
    const result = build([
      thread("a", 1, { tags: ["in:Tasks"], cls: "needsYou" }),
      thread("b", 2, { forkOf: "a", cls: "working" }),
      thread("c", 3, { tags: ["in:Tasks/Sub"], cls: "done" }),
      thread("d", 4, { tags: ["in:Tasks/Sub"], cls: "waiting" }),
    ]);
    expect(result.folders[0]!.counts).toEqual({
      needsYou: 1,
      failed: 0,
      done: 1,
      working: 1,
      total: 4,
    });
    const sub = result.folders[0]!.units.find((unit) => unit.kind === "subfolder");
    expect(sub?.kind === "subfolder" ? sub.counts.total : null).toBe(2);
  });
});

describe("flattenSidebarUserFolders", () => {
  const threads = [
    thread("solo", 1, { tags: ["in:Tasks/One"] }),
    thread("a", 2, { tags: ["in:Tasks/Two"] }),
    thread("b", 3, { tags: ["in:Tasks/Two"] }),
    thread("fork", 4, { forkOf: "a" }),
  ];
  const rows = (collapsed: ReadonlyArray<string>, routeKey: string | null = null) =>
    flattenSidebarUserFolders({
      folders: build(threads).folders,
      isCollapsed: (path) => collapsed.includes(path),
      routeKey,
    }).map((row) =>
      row.kind === "heading"
        ? `${"  ".repeat(row.depth)}[${row.name}] <${row.parentRowId ?? "-"}>`
        : `${"  ".repeat(row.depth)}${row.thread.id}${row.relation ? ` (${row.relation})` : ""} <${row.parentRowId}>`,
    );

  it("draws a one-session subfolder as its row and nests children under their parent", () => {
    expect(rows([])).toEqual([
      "[Tasks] <->",
      "  solo <ufolder:Tasks>",
      "  [Two] <ufolder:Tasks>",
      "    a <ufolder:Tasks/Two>",
      "      fork (fork) <local:a>",
      "    b <ufolder:Tasks/Two>",
    ]);
  });

  it("keeps only the open thread under a folded heading", () => {
    expect(rows(["Tasks/Two"], "local:fork")).toEqual([
      "[Tasks] <->",
      "  solo <ufolder:Tasks>",
      "  [Two] <ufolder:Tasks>",
      "      fork (fork) <local:a>",
    ]);
    expect(rows(["Tasks"], "local:b")).toEqual([
      "[Tasks] <->",
      "  [Two] <ufolder:Tasks>",
      "    b <ufolder:Tasks/Two>",
    ]);
    expect(rows(["Tasks"])).toEqual(["[Tasks] <->"]);
  });
});

describe("resolveAdjacentAttentionKey", () => {
  const classByKey = new Map<string, SidebarAttentionClass>([
    ["a", "done"],
    ["b", "needsYou"],
    ["c", "idle"],
    ["d", "needsYou"],
    ["e", "failed"],
  ]);
  const orderedKeys = ["a", "b", "c", "d", "e"];

  it("goes through the most urgent class first, wrapping around", () => {
    const next = (currentKey: string | null) =>
      resolveAdjacentAttentionKey({ orderedKeys, classByKey, currentKey, direction: "next" });
    expect(next(null)).toBe("b");
    expect(next("b")).toBe("d");
    expect(next("d")).toBe("b");
    expect(next("c")).toBe("d");
    expect(
      resolveAdjacentAttentionKey({
        orderedKeys,
        classByKey,
        currentKey: "b",
        direction: "previous",
      }),
    ).toBe("d");
  });

  it("falls back to failed, then done, and returns null when nothing is left", () => {
    const only = (entries: Array<[string, SidebarAttentionClass]>, currentKey: string | null) =>
      resolveAdjacentAttentionKey({
        orderedKeys,
        classByKey: new Map(entries),
        currentKey,
        direction: "next",
      });
    expect(
      only(
        [
          ["a", "done"],
          ["e", "failed"],
        ],
        null,
      ),
    ).toBe("e");
    expect(only([["a", "done"]], null)).toBe("a");
    expect(only([["a", "done"]], "a")).toBeNull();
    expect(only([["c", "idle"]], null)).toBeNull();
  });
});

describe("layout edits", () => {
  it("adds, renames and removes folders with their subfolders", () => {
    const added = upsertSidebarFolder(upsertSidebarFolder([], "Customers/PuL"), "Customers");
    expect(added).toEqual([{ path: "Customers" }, { path: "Customers/PuL" }]);
    const renamed = renameSidebarFolder(
      [
        { path: "Customers", icon: "users" },
        { path: "Customers/PuL", sort: "title" },
      ],
      "Customers",
      "Clients",
    );
    expect(renamed).toEqual([
      { path: "Clients", icon: "users" },
      { path: "Clients/PuL", sort: "title" },
    ]);
    expect(removeSidebarFolder(renamed, "Clients")).toEqual([]);
    expect(
      removeSidebarFolder(
        [{ path: "Tasks", sort: "manual", order: ["/Sub", "t1"] }, { path: "Tasks/Sub" }],
        "Tasks/Sub",
      ),
    ).toEqual([{ path: "Tasks", sort: "manual", order: ["t1"] }]);
  });

  it("sets and clears an icon and a sort, adding the folder when it is not saved yet", () => {
    const withIcon = setSidebarFolderIcon([], "Team", "users");
    expect(withIcon).toEqual([{ path: "Team", icon: "users" }]);
    expect(setSidebarFolderIcon(withIcon, "Team", null)).toEqual([{ path: "Team" }]);
    expect(setSidebarFolderSort(withIcon, "Team/Daily", "title")).toEqual([
      { path: "Team", icon: "users" },
      { path: "Team/Daily", sort: "title" },
    ]);
  });

  it("moves a top folder among the drawn ones and saves the whole order", () => {
    expect(moveSidebarTopFolder([{ path: "B", icon: "star" }], ["B", "A", "C"], "C", "B")).toEqual([
      { path: "C" },
      { path: "B", icon: "star" },
      { path: "A" },
    ]);
    expect(moveSidebarTopFolder([], ["A", "B"], "A", null)).toEqual([{ path: "B" }, { path: "A" }]);
  });

  it("places a unit before or after another and saves the drawn order", () => {
    expect(
      placeSidebarFolderUnit(
        [{ path: "Tasks", sort: "manual" }],
        "Tasks",
        ["t1", "/Sub", "t2"],
        "t2",
        "t1",
        "before",
      ),
    ).toEqual([{ path: "Tasks", sort: "manual", order: ["t2", "t1", "/Sub"] }]);
    expect(placeSidebarFolderUnit([], "Tasks", ["t1", "t2"], "t1", "t2", "after")).toEqual([
      { path: "Tasks", sort: "manual", order: ["t2", "t1"] },
    ]);
  });
});

describe("planSidebarFolderDrop", () => {
  const knownPaths = ["Team", "Customers", "Customers/PuL", "Tasks"];
  const displayedTops = ["Team", "Customers", "Tasks"];
  const drop = (from: string, to: string, zone: "before" | "after" | "into") =>
    planSidebarFolderDrop({ layout: [], knownPaths, displayedTops, from, to, zone });

  it("reorders top folders", () => {
    expect(drop("Tasks", "Team", "before")).toEqual({
      rename: null,
      layout: [{ path: "Tasks" }, { path: "Team" }, { path: "Customers" }],
    });
    expect(drop("Team", "Customers", "after")?.layout.map((entry) => entry.path)).toEqual([
      "Customers",
      "Team",
      "Tasks",
    ]);
  });

  it("nests a top folder into another, and lifts a subfolder out", () => {
    expect(drop("Team", "Tasks", "into")).toEqual({
      rename: { from: "Team", to: "Tasks/Team" },
      layout: [],
    });
    expect(drop("Customers/PuL", "Team", "after")).toEqual({
      rename: { from: "Customers/PuL", to: "PuL" },
      layout: [{ path: "Team" }, { path: "PuL" }, { path: "Customers" }, { path: "Tasks" }],
    });
  });

  it("reorders sibling subfolders only in a folder kept in its own order", () => {
    const sibling = (sort: "manual" | "created") =>
      planSidebarFolderDrop({
        layout: [{ path: "Customers", sort }],
        knownPaths: [...knownPaths, "Customers/Brummer"],
        displayedTops,
        from: "Customers/Brummer",
        to: "Customers/PuL",
        zone: "before",
        unitKeysOf: () => ["/PuL", "t1", "/Brummer"],
      });
    expect(sibling("manual")).toEqual({
      rename: null,
      layout: [{ path: "Customers", sort: "manual", order: ["/Brummer", "/PuL", "t1"] }],
    });
    expect(sibling("created")).toBeNull();
  });

  it("refuses what would need a third level, a clash or a no-op", () => {
    expect(drop("Customers", "Tasks", "into")).toBeNull();
    expect(drop("Team", "Customers/PuL", "into")).toBeNull();
    expect(drop("Team", "Team", "before")).toBeNull();
    expect(drop("Customers/PuL", "Customers", "into")).toBeNull();
    expect(
      planSidebarFolderDrop({
        layout: [],
        knownPaths: [...knownPaths, "Tasks/Team"],
        displayedTops,
        from: "Team",
        to: "Tasks",
        zone: "into",
      }),
    ).toBeNull();
  });
});
