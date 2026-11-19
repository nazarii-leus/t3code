import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type LocalApi,
  ProjectId,
  type SidebarFolderEntry,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useSidebarFolderLayout } from "../hooks/useSidebarFolderLayout";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { readLocalApi } from "../localApi";
import { useProjects, useQuietThreadShells } from "../state/entities";
import { makeThreadFixture } from "../test-fixtures";
import type { Project } from "../types";
import { useUiStateStore } from "../uiStateStore";
import Sidebar from "./Sidebar";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("../hooks/useSidebarFolderLayout", { spy: true });
vi.mock("../localApi", { spy: true });
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "f8", command: "thread.nextAttention", when: "!terminalFocus" },
    { key: "alt+m", command: "thread.moveToFolder", when: "!terminalFocus && !editableFocus" },
  ]);
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

const ENV = EnvironmentId.make("local");
const PROJECT: Project = {
  id: ProjectId.make("work"),
  environmentId: ENV,
  title: "work",
  workspaceRoot: "/projects/work",
  repositoryIdentity: null,
  defaultModelSelection: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  scripts: [],
};

function thread(
  index: number,
  title: string,
  options: {
    tags?: ReadonlyArray<string>;
    forkOf?: number;
    hasPendingApprovals?: boolean;
  } = {},
): EnvironmentThreadShell {
  const id = ThreadId.make(`thread-${index}`);
  const fixture = makeThreadFixture({
    environmentId: ENV,
    id,
    projectId: PROJECT.id,
    title,
    createdAt: `2026-11-19T10:0${index}:00.000Z`,
    hasPendingApprovals: options.hasPendingApprovals ?? false,
    ...(options.forkOf === undefined
      ? {}
      : {
          lineage: {
            rootThreadId: ThreadId.make(`thread-${options.forkOf}`),
            parentThreadId: ThreadId.make(`thread-${options.forkOf}`),
            relationshipToParent: "fork" as const,
          },
        }),
  });
  return { ...fixture, source: { ...fixture.source, tags: [...(options.tags ?? [])] } };
}

const THREADS = [
  thread(1, "Daily plan", { tags: ["in:Team"] }),
  thread(2, "PuL incident", { tags: ["in:Customers/PuL"] }),
  thread(3, "Brummer camera", { tags: ["in:Customers/Brummer"] }),
  thread(4, "Brummer update", { tags: ["in:Customers/Brummer"], hasPendingApprovals: true }),
  thread(5, "Brummer camera fork", { forkOf: 3 }),
  thread(6, "Unfiled question"),
];

function setup(input: {
  threads: ReadonlyArray<EnvironmentThreadShell>;
  layout: ReadonlyArray<SidebarFolderEntry>;
  routeThread: number;
}) {
  const stack = new DisposableStack();
  // Fold state persists per device; every test starts with all folders open.
  useUiStateStore.setState({ projectExpandedById: {} });
  const previousSettings = getClientSettings();
  stack.defer(() => __setClientSettingsForTests(previousSettings));
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, boringSidebarEnabled: true });
  const threadRef = { environmentId: ENV, threadId: ThreadId.make(`thread-${input.routeThread}`) };
  const show = vi.fn().mockResolvedValue(null);
  vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
  vi.mocked(useProjects).mockReturnValue([PROJECT]);
  vi.mocked(useQuietThreadShells).mockReturnValue([...input.threads]);
  vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef });
  const save = vi.fn();
  vi.mocked(useSidebarFolderLayout).mockReturnValue({
    layout: input.layout,
    available: true,
    save,
  });
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: { environmentId: ENV, projectId: PROJECT.id },
    defaultProjectFallbackReady: true,
    handleNewThread: vi.fn().mockResolvedValue(null),
    routeDraftId: null,
    routeThreadRef: threadRef,
  });
  return { stack, show, save };
}

const renderSidebar = () =>
  render(
    <SidebarProvider>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>,
  );

function treeRows(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-sidebar-row]"))
    .map((row) => [row.dataset.sidebarRow!, row.dataset.sidebarParent ?? null] as const)
    .filter(([id]) => /^(ufolder|folder|local):/.test(id))
    .map(
      ([id, parent]) =>
        `${id.startsWith("folder:") ? "folder:project" : id} <${
          parent?.startsWith("folder:") ? "folder:project" : parent
        }>`,
    );
}

describe("sidebar folders", () => {
  it("draws the user's folders above the project folders as a tree", async () => {
    const { stack } = setup({
      threads: THREADS,
      layout: [{ path: "Team" }, { path: "Customers" }],
      routeThread: 1,
    });
    using _stack = stack;
    await using screen = await renderSidebar();
    await expect.element(screen.getByText("Brummer camera fork")).toBeInTheDocument();
    expect(treeRows(screen.container)).toEqual([
      "ufolder:Team <null>",
      "local:thread-1 <ufolder:Team>",
      "ufolder:Customers <null>",
      "local:thread-2 <ufolder:Customers>",
      "ufolder:Customers/Brummer <ufolder:Customers>",
      "local:thread-3 <ufolder:Customers/Brummer>",
      "local:thread-5 <local:thread-3>",
      "local:thread-4 <ufolder:Customers/Brummer>",
      "folder:project <null>",
      "local:thread-6 <folder:project>",
    ]);
  });

  it("folds a folder to its counts and keeps the open thread", async () => {
    const { stack } = setup({ threads: THREADS, layout: [], routeThread: 2 });
    using _stack = stack;
    await using screen = await renderSidebar();
    const customers = page.getByRole("button", { name: /^Customers/ });
    await expect.element(customers).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(customers);
    await expect.element(customers).toHaveAttribute("aria-expanded", "false");
    await expect
      .element(screen.getByText("Brummer camera", { exact: true }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByText("PuL incident")).toBeInTheDocument();
    // One thread needs you, four are in the folder; ICU wraps the count in bidi isolates.
    expect(customers.element().textContent?.replace(/[^\w ]/gu, "")).toBe("Customers11 need you4");
  });

  it("jumps to the thread that needs you with F8 and opens the folder menu with Alt+M", async () => {
    const { stack, show } = setup({ threads: THREADS, layout: [], routeThread: 1 });
    using _stack = stack;
    await using screen = await renderSidebar();
    const row = screen.getByText("PuL incident");
    await expect.element(row).toBeInTheDocument();
    row.element().closest<HTMLElement>("[data-sidebar-row]")!.focus();
    await userEvent.keyboard("{F8}");
    await vi.waitFor(() => expect(screen.router?.state.location.pathname).toBe("/local/thread-4"));
    row.element().closest<HTMLElement>("[data-sidebar-row]")!.focus();
    await userEvent.keyboard("{Alt>}m{/Alt}");
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    const [items, , source] = show.mock.lastCall!;
    expect(source).toBe("keyboard");
    expect(items.map((item: { id: string; checked?: boolean }) => [item.id, item.checked])).toEqual(
      [
        ["move-to-folder:path:Customers", false],
        ["move-to-folder:path:Customers/PuL", true],
        ["move-to-folder:path:Customers/Brummer", false],
        ["move-to-folder:path:Team", false],
        ["move-to-folder:new", undefined],
        ["move-to-folder:none", undefined],
      ],
    );
  });

  it("freezes a counter's list until Esc", async () => {
    const { stack } = setup({ threads: THREADS, layout: [], routeThread: 1 });
    using _stack = stack;
    await using screen = await renderSidebar();
    const counter = screen.getByRole("button", { name: /^Need you/ });
    // The shift guard drops pointer presses on controls that just appeared; keys pass.
    counter.element().focus();
    await userEvent.keyboard("{Enter}");
    const filtered = screen.getByRole("listbox", { name: "Filtered threads" });
    await expect.element(filtered.getByText("Brummer update")).toBeInTheDocument();
    expect(filtered.element().querySelectorAll("li")).toHaveLength(1);
    // Answered: no longer needs you, but the list holds still.
    vi.mocked(useQuietThreadShells).mockReturnValue(
      THREADS.map((entry) =>
        entry.id === ThreadId.make("thread-4") ? { ...entry, hasPendingApprovals: false } : entry,
      ),
    );
    await screen.rerender(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(filtered.getByText("Brummer update")).toBeInTheDocument();
    expect(filtered.element().querySelectorAll("li")).toHaveLength(1);
    counter.element().focus();
    await userEvent.keyboard("{Escape}");
    await expect.element(filtered).not.toBeInTheDocument();
    await expect
      .element(screen.getByTestId("sidebar-row-folder").filter({ hasText: "Daily plan" }))
      .toBeInTheDocument();
  });

  it("shows the strip only with folders or 13 threads", async () => {
    const plain = (count: number) =>
      Array.from({ length: count }, (_, index) => thread(index + 1, `Plain ${index + 1}`));
    {
      const { stack } = setup({ threads: plain(12), layout: [], routeThread: 1 });
      using _stack = stack;
      await using screen = await renderSidebar();
      await expect.element(screen.getByText("Plain 12")).toBeInTheDocument();
      await expect.element(screen.getByTestId("sidebar-attention-strip")).not.toBeInTheDocument();
    }
    {
      const { stack } = setup({ threads: plain(13), layout: [], routeThread: 1 });
      using _stack = stack;
      await using screen = await renderSidebar();
      await expect.element(screen.getByTestId("sidebar-attention-strip")).toBeInTheDocument();
    }
  });
});
