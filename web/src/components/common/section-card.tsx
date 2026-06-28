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
    <section className={cn("flex flex-col rounded-xl border border-border bg-card", className)}>
      {(title || extra) && (
        <header className="flex items-center justify-between gap-3 px-4 pb-3 pt-4">
          {title && (
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
          )}
          {extra && <div className="text-xs text-muted-foreground">{extra}</div>}
        </header>
      )}
      <div className={cn("flex-1 px-4 pb-4", bodyClassName)}>{children}</div>
    </section>
  );
}
