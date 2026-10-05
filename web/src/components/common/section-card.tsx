import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SectionCardProps {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

/** A titled panel — the building block for every dashboard section. */
export function SectionCard({ title, extra, children, className, bodyClassName }: SectionCardProps) {
  return (
    // min-w-0: a grid/flex item otherwise grows to its widest child (a wide
    // table, a chart) and pushes the page past a phone screen
    <section className={cn("flex min-w-0 flex-col rounded-xl border border-border bg-card", className)}>
      {(title || extra) && (
        <header className="flex items-center justify-between gap-3 px-4 pb-3 pt-4">
          {title && (
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
          )}
          {extra && <div className="text-xs text-muted-foreground">{extra}</div>}
        </header>
      )}
      <div className={cn("min-w-0 flex-1 px-4 pb-4", bodyClassName)}>{children}</div>
    </section>
  );
}
