import type { PolicyLimitRow } from "@/lib/policy-hints";
import { cn } from "@/lib/utils";

export function PolicyLimitChips({ rows }: { rows: PolicyLimitRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {rows.map((row) => (
        <span
          key={row.key}
          className={cn(
            "rounded-md border px-1.5 py-0.5 text-xs",
            row.reached
              ? "border-bad/30 bg-bad-soft text-bad-fg"
              : row.near
                ? "border-warn/30 bg-warn-soft text-warn-fg"
                : "border-border bg-muted/40 text-muted-foreground",
          )}
        >
          {row.label}
        </span>
      ))}
    </div>
  );
}
