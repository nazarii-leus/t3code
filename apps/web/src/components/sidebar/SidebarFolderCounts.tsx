import { msg, useMessages } from "gt-react";

import { cn } from "~/lib/utils";
import type { SidebarFolderCounts as Counts } from "../../sidebarUserFolders";

const CLASS_MARKS = [
  { key: "needsYou", dot: "bg-warning", label: msg("{count} need you") },
  { key: "failed", dot: "bg-error", label: msg("{count} failed") },
  { key: "done", dot: "bg-success", label: msg("{count} done") },
  { key: "working", dot: "bg-info", label: msg("{count} working") },
] as const;

/** A folded folder says what its hidden threads need; an open one only how many it holds. */
export function SidebarFolderCounts(props: {
  counts: Counts;
  showClasses: boolean;
  className?: string;
}) {
  const m = useMessages();
  const marks = props.showClasses ? CLASS_MARKS.filter((mark) => props.counts[mark.key] > 0) : [];
  if (marks.length === 0 && props.counts.total === 0) return null;
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-2 text-xs tabular-nums text-sidebar-muted-foreground",
        props.className,
      )}
    >
      {marks.map((mark) => (
        <span key={mark.key} className="flex items-center gap-1">
          <span aria-hidden className={cn("size-1.5 rounded-full", mark.dot)} />
          <span aria-hidden>{props.counts[mark.key]}</span>
          <span className="sr-only">{m(mark.label, { count: props.counts[mark.key] })}</span>
        </span>
      ))}
      {props.counts.total > 0 ? <span>{props.counts.total}</span> : null}
    </span>
  );
}
