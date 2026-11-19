import { msg, useGT, useMessages } from "gt-react";
import { ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import type { SidebarAttentionClass, SidebarFolderCounts } from "../../sidebarUserFolders";
import { Button } from "../ui/button";

export type SidebarAttentionFilterClass = Extract<
  SidebarAttentionClass,
  "needsYou" | "failed" | "done" | "working"
>;

const COUNTERS = [
  { cls: "needsYou", dot: "bg-warning", label: msg("Need you: {count}") },
  { cls: "failed", dot: "bg-error", label: msg("Failed: {count}") },
  { cls: "done", dot: "bg-success", label: msg("Done: {count}") },
  { cls: "working", dot: "bg-info", label: msg("Working: {count}") },
] as const;

/**
 * Four counters under the search field. A click lists that class only, frozen as
 * it was at the click, so a thread the user just answered does not jump away.
 */
export function SidebarAttentionStrip(props: {
  counts: SidebarFolderCounts;
  active: SidebarAttentionFilterClass | null;
  allFolded: boolean;
  onSelect: (cls: SidebarAttentionFilterClass) => void;
  onToggleFoldAll: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  return (
    <div
      data-testid="sidebar-attention-strip"
      data-sidebar-attention-strip
      className="flex items-center gap-1 px-(--sidebar-row-content-inset) pt-1"
    >
      {COUNTERS.map((counter) => {
        const count = props.counts[counter.cls];
        return (
          <button
            key={counter.cls}
            type="button"
            aria-pressed={props.active === counter.cls}
            aria-label={m(counter.label, { count })}
            disabled={count === 0 && props.active !== counter.cls}
            onClick={() => props.onSelect(counter.cls)}
            className={cn(
              "flex h-6 items-center gap-1.5 rounded-(--control-radius) px-1.5 text-xs tabular-nums text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-40 disabled:hover:bg-transparent",
              props.active === counter.cls && "bg-sidebar-row-hover text-sidebar-foreground",
            )}
          >
            <span aria-hidden className={cn("size-1.5 rounded-full", counter.dot)} />
            {count}
          </button>
        );
      })}
      <span className="ml-auto">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={props.allFolded ? gt("Unfold all folders") : gt("Fold all folders")}
          onClick={props.onToggleFoldAll}
        >
          {props.allFolded ? (
            <ChevronsUpDownIcon aria-hidden />
          ) : (
            <ChevronsDownUpIcon aria-hidden />
          )}
        </Button>
      </span>
    </div>
  );
}
