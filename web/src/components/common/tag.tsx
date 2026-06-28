import type { ReactNode } from "react";
import { toneClass, type Tone } from "@/lib/slurm";
import { cn } from "@/lib/utils";

/** Small status pill coloured by tone (Radix soft bg + foreground). */
export function Tag({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  const c = toneClass[tone];
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold",
        c.bg,
        c.text,
        className,
      )}
    >
      {children}
    </span>
  );
}
