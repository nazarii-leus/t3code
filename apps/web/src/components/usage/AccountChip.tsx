import { useGT } from "gt-react";

import { cn } from "../../lib/utils";

export function accountInitials(label: string): string {
  if (label.includes("@")) {
    const [local = "", domain = ""] = label.split("@");
    return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
  }
  return (
    label
      .split(/[\s._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join("") || "?"
  );
}

function accountHue(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

/** A coloured circle with initials. The colour follows `seed` (an account id), so two accounts with one email differ. */
export function AccountChip({
  seed,
  label,
  className = "size-4 text-3xs",
}: {
  readonly seed: string;
  readonly label: string;
  readonly className?: string;
}) {
  const gt = useGT();
  const hue = accountHue(seed);
  const initials = accountInitials(label);
  return (
    <span
      role="img"
      aria-label={gt("Account {initials}", { initials })}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full leading-none font-semibold",
        className,
      )}
      style={{ backgroundColor: `oklch(0.85 0.08 ${hue})`, color: `oklch(0.35 0.1 ${hue})` }}
    >
      {initials}
    </span>
  );
}
