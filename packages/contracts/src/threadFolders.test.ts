import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  matchKnownThreadFolder,
  moveSidebarTopFolder,
  placeSidebarFolderUnit,
  removeSidebarFolder,
  renameSidebarFolder,
  setSidebarFolderIcon,
  setSidebarFolderSort,
  upsertSidebarFolder,
  parseThreadFolderPath,
  planThreadFolderTagChanges,
  renameThreadFolderPath,
  threadFolderOf,
  threadParentTag,
  threadParentTagOf,
  withThreadFolderTag,
} from "./threadFolders.ts";
import { ThreadTag } from "./threadTags.ts";

describe("parseThreadFolderPath", () => {
  it("accepts one or two trimmed segments", () => {
    expect(parseThreadFolderPath(" Customers ")).toEqual({
      path: "Customers",
      top: "Customers",
      sub: null,
    });
    expect(parseThreadFolderPath("Customers / PuL")).toEqual({
      path: "Customers/PuL",
      top: "Customers",
      sub: "PuL",
    });
  });

  it.each(["", " / ", "A/", "/B", "A/B/C", `${"x".repeat(61)}`, "A\nB"])("refuses %j", (input) => {
    expect(parseThreadFolderPath(input)).toBeNull();
  });
});

describe("folder and parent tags", () => {
  it("reads the last valid folder tag", () => {
    expect(threadFolderOf(["in:Tasks", "other", "in:Customers/PuL", "in:A/B/C"])?.path).toBe(
      "Customers/PuL",
    );
    expect(threadFolderOf(["in:", "private"])).toBeNull();
    expect(threadFolderOf(undefined)).toBeNull();
  });

  it("reads the last parent tag", () => {
    expect(threadParentTagOf(["parent:a", threadParentTag("b")])).toBe("b");
    expect(threadParentTagOf(["parent:"])).toBeNull();
  });

  it("fits a parent tag for a 75-character thread id and refuses 129 characters", () => {
    const decode = Schema.decodeUnknownExit(ThreadTag);
    expect(decode(threadParentTag("t".repeat(75)))._tag).toBe("Success");
    expect(decode("x".repeat(129))._tag).toBe("Failure");
  });
});

describe("planThreadFolderTagChanges", () => {
  it("adds the new folder before removing every other folder tag", () => {
    expect(planThreadFolderTagChanges(["keep", "in:Tasks", "in:"], "Customers/PuL")).toEqual([
      { tag: "in:Customers/PuL", tagged: true },
      { tag: "in:Tasks", tagged: false },
      { tag: "in:", tagged: false },
    ]);
  });

  it("changes nothing when the folder is already the only folder tag", () => {
    expect(planThreadFolderTagChanges(["keep", "in:Tasks"], "Tasks")).toEqual([]);
  });

  it("only removes the others when the folder tag is present but not last", () => {
    expect(planThreadFolderTagChanges(["in:Tasks", "in:Team"], "Tasks")).toEqual([
      { tag: "in:Team", tagged: false },
    ]);
  });

  it("ends with the same tags as the optimistic update", () => {
    for (const [tags, path] of [
      [["keep", "in:Tasks", "in:"], "Customers/PuL"],
      [["in:Tasks", "in:Team"], "Tasks"],
      [["in:Tasks", "keep"], null],
    ] as const) {
      let applied: string[] = [...tags];
      for (const change of planThreadFolderTagChanges(tags, path)) {
        applied = change.tagged
          ? [...applied, change.tag]
          : applied.filter((tag) => tag !== change.tag);
      }
      expect(applied).toEqual(withThreadFolderTag(tags, path));
    }
  });

  it("unfiles by removing every folder tag", () => {
    expect(planThreadFolderTagChanges(["in:Tasks", "keep"], null)).toEqual([
      { tag: "in:Tasks", tagged: false },
    ]);
    expect(planThreadFolderTagChanges(["keep"], null)).toEqual([]);
  });
});

describe("renameThreadFolderPath", () => {
  it("moves the folder and anything under it", () => {
    expect(renameThreadFolderPath("Customers", "Customers", "Clients")).toBe("Clients");
    expect(renameThreadFolderPath("Customers/PuL", "Customers", "Clients")).toBe("Clients/PuL");
    expect(renameThreadFolderPath("Customers/PuL", "Customers/PuL", "Tasks/PuL")).toBe("Tasks/PuL");
    expect(renameThreadFolderPath("CustomersX", "Customers", "Clients")).toBeNull();
  });
});

describe("matchKnownThreadFolder", () => {
  it("reuses an existing spelling ignoring case, per segment", () => {
    const known = ["Customers", "Customers/PuL", "Tasks"];
    expect(matchKnownThreadFolder("customers/pul", known)).toBe("Customers/PuL");
    expect(matchKnownThreadFolder("customers/Brummer", known)).toBe("Customers/Brummer");
    expect(matchKnownThreadFolder("Team", known)).toBe("Team");
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
