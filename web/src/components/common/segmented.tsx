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
  size = "sm",
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  className?: string;
  itemClassName?: string;
  ariaLabel?: string;
  /** "lg": a page-level switch (Analytics GPU/CPU) — taller, and the chosen
   *  option filled with the primary colour so it reads at a glance */
  size?: "sm" | "lg";
}) {
  const lg = size === "lg";
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex shrink-0 items-stretch rounded-md border border-border bg-muted/50",
        lg ? "h-9 gap-1 p-1" : "h-7 p-0.5",
        className,
      )}
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
              // labels never wrap: "スクリプト" in a two-option toggle must stay one line
              "flex-1 whitespace-nowrap rounded-[4px] outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-primary/45",
              lg ? "inline-flex items-center justify-center gap-1.5 px-4 text-sm font-medium" : "px-2.5 text-xs",
              selected
                ? lg
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-background font-medium text-foreground shadow-sm"
                : lg
                  ? "text-muted-foreground hover:bg-background/70 hover:text-foreground"
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
