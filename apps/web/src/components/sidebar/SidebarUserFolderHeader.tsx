import type { ContextMenuSource } from "@t3tools/contracts";
import {
  BookOpenIcon,
  BriefcaseIcon,
  BugIcon,
  Building2Icon,
  ChevronDownIcon,
  FlagIcon,
  FolderIcon,
  InboxIcon,
  ListChecksIcon,
  type LucideIcon,
  RocketIcon,
  SquarePenIcon,
  StarIcon,
  UsersIcon,
  WrenchIcon,
} from "lucide-react";
import { T, useGT, Var } from "gt-react";
import { memo, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { contextMenuSourceOf } from "../../contextMenuSource";
import type { SidebarFolderCounts as Counts } from "../../sidebarUserFolders";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarFolderCounts } from "./SidebarFolderCounts";

/** Icons a top folder can carry, by the name saved in the folder layout. */
export const SIDEBAR_FOLDER_ICONS: Readonly<Record<string, LucideIcon>> = {
  folder: FolderIcon,
  users: UsersIcon,
  briefcase: BriefcaseIcon,
  building: Building2Icon,
  "list-checks": ListChecksIcon,
  inbox: InboxIcon,
  star: StarIcon,
  flag: FlagIcon,
  bug: BugIcon,
  wrench: WrenchIcon,
  rocket: RocketIcon,
  book: BookOpenIcon,
};

export interface SidebarFolderNameEdit {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onCommit: () => void;
  readonly onCancel: () => void;
}

function FolderNameInput(props: SidebarFolderNameEdit & { label: string }) {
  // Enter and Escape blur the input as it unmounts; that blur must not commit again.
  const settledRef = useRef(false);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      settledRef.current = true;
      props.onCommit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      settledRef.current = true;
      props.onCancel();
    }
  };
  return (
    <input
      autoFocus
      aria-label={props.label}
      value={props.value}
      dir="auto"
      maxLength={60}
      className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-sidebar-foreground outline-none ring-1 ring-ring"
      onChange={(event) => props.onChange(event.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (!settledRef.current) props.onCancel();
      }}
    />
  );
}

/**
 * A folder or subfolder of the user's own. It reads like a project folder heading;
 * folded, it counts what its hidden threads need.
 */
export const SidebarUserFolderHeader = memo(function SidebarUserFolderHeader(props: {
  path: string;
  name: string;
  depth: 0 | 1;
  icon: string | null;
  collapsed: boolean;
  counts: Counts;
  rowId: string;
  parentRowId: string | null;
  edit: SidebarFolderNameEdit | null;
  onToggle: (path: string) => void;
  onNewThread: ((path: string) => void) | null;
  onContextMenu: (
    path: string,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}) {
  const gt = useGT();
  const { path, name, collapsed } = props;
  const Icon =
    props.depth === 0 ? (SIDEBAR_FOLDER_ICONS[props.icon ?? "folder"] ?? FolderIcon) : null;
  const content = (
    <>
      {Icon ? <Icon aria-hidden className="size-4 shrink-0 text-sidebar-muted-foreground" /> : null}
      {props.edit ? (
        <FolderNameInput {...props.edit} label={gt("Folder name")} />
      ) : (
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-sm text-sidebar-foreground/90",
            props.depth === 0 && "font-medium",
          )}
        >
          {name}
        </span>
      )}
      <SidebarFolderCounts
        counts={props.counts}
        showClasses={collapsed}
        className="group-hover/user-folder:invisible group-has-[[data-sidebar-action-for]:focus]/user-folder:invisible pointer-coarse:invisible"
      />
      <ChevronDownIcon
        aria-hidden
        className={cn(
          "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
          collapsed && "-rotate-90",
        )}
      />
    </>
  );
  return (
    <li
      data-testid="sidebar-user-folder"
      className={cn("group/user-folder relative list-none", props.depth === 0 && "mt-2 first:mt-0")}
    >
      {props.edit ? (
        <div className="flex h-8 w-full items-center gap-2.5 px-(--sidebar-row-content-inset)">
          {content}
        </div>
      ) : (
        <button
          type="button"
          data-sidebar-row={props.rowId}
          data-sidebar-parent={props.parentRowId ?? undefined}
          aria-expanded={!collapsed}
          onClick={() => props.onToggle(path)}
          onContextMenu={(event) => {
            event.preventDefault();
            props.onContextMenu(
              path,
              { x: event.clientX, y: event.clientY },
              contextMenuSourceOf(event),
            );
          }}
          className={cn(
            "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) px-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            props.depth === 1 && "ps-9",
          )}
        >
          {content}
        </button>
      )}
      {props.onNewThread && !props.edit ? (
        <span className="absolute inset-y-0 right-6 flex items-center opacity-0 focus-within:opacity-100 group-hover/user-folder:opacity-100 pointer-coarse:opacity-100">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  data-sidebar-action-for={props.rowId}
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={gt("New thread in {folder}", { folder: name })}
                  onClick={() => props.onNewThread?.(path)}
                />
              }
            >
              <SquarePenIcon aria-hidden />
            </TooltipTrigger>
            <TooltipPopup>
              <T>
                New thread in <Var>{name}</Var>
              </T>
            </TooltipPopup>
          </Tooltip>
        </span>
      ) : null}
    </li>
  );
});
