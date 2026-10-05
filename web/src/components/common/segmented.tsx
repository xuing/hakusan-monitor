import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

/** The one segmented control: a quiet muted track with the selected option
 *  lifted as a card-coloured pill (shadcn Tabs look). Selection reads from
 *  contrast, not from a saturated fill, so it never outweighs the content
 *  it switches. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  itemClassName,
  ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  className?: string;
  itemClassName?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn("inline-flex h-7 shrink-0 items-stretch rounded-md border border-border bg-muted/50 p-0.5", className)}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={selected}
            className={cn(
              "flex-1 rounded-[4px] px-2.5 text-xs outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-primary/45",
              selected
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
              itemClassName,
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
