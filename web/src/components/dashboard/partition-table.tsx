import type { ReactNode } from "react";
import { Tag } from "@/components/common/tag";
import type { Tone } from "@/lib/slurm";
import { cn } from "@/lib/utils";

export interface PartitionTableRow {
  name: string;
  /** hover text: the partition's one-line description */
  title?: string;
  /** what one job may ask for (cores or GPUs) */
  lo: number;
  hi: number;
  /** most of it that starts now; below `lo` = none */
  now: number;
  wall: string;
  perUser?: number;
  verdict: { tone: Tone; label: string } | null;
  selected: boolean;
  /** the selected row's current request, drawn on its bar */
  marker?: number;
}

export interface PartitionAxis {
  scale: "log" | "linear";
  min: number;
  max: number;
  /** `minor` ticks drop out below the sm breakpoint, where the bar is narrow */
  ticks: { value: number; label: string; minor?: boolean }[];
}

// columns follow the table's own width (it sits in half-width cards too):
// the time column from @md, the per-user column from @2xl
const GRID = "grid grid-cols-[5.25rem_minmax(0,1fr)_5.5rem] items-center gap-x-3 px-3 @md:grid-cols-[5.5rem_minmax(0,1fr)_6.5rem_5.5rem] @2xl:grid-cols-[5.75rem_minmax(0,1fr)_6.5rem_2.5rem_5.5rem]";

/** Partitions side by side on one axis: each row's bar is what a job there
 *  may ask for, its green part what starts now. Clicking a row picks it. */
export function PartitionTable({
  rows,
  axis,
  onSelect,
  headers,
  legend,
  footer,
  rangeLabels = true,
}: {
  rows: PartitionTableRow[];
  axis: PartitionAxis;
  onSelect: (name: string) => void;
  headers: { name: string; wall: string; perUser: string; verdict: string };
  legend: { range: string; now: string };
  footer?: ReactNode;
  /** "lo–hi" beside each bar; off where the axis already ticks every value */
  rangeLabels?: boolean;
}) {
  const logSpan = Math.log(axis.max / axis.min) || 1;
  // with range labels the axis uses 80% of the cell: a label after a bar that
  // starts at the axis origin always has room, and one before a bar that
  // starts further in sits in the empty part on its left
  const reach = rangeLabels ? 0.8 : 1;
  const pos = (v: number) => {
    const c = Math.min(axis.max, Math.max(axis.min, v));
    return reach * (axis.scale === "log" ? Math.log(c / axis.min) / logSpan : (c - axis.min) / Math.max(axis.max - axis.min, 1));
  };
  return (
    <div className="@container overflow-hidden rounded-lg border border-border bg-card">
      <div className={cn(GRID, "border-b border-border bg-muted/40 py-1.5 text-xs text-muted-foreground")}>
        <span>{headers.name}</span>
        <div className="relative h-4 font-mono">
          {axis.ticks.map((tk) => {
            const p = pos(tk.value);
            return (
              <span
                key={tk.value}
                className={cn("absolute whitespace-nowrap", tk.minor && "hidden @xl:inline")}
                style={{ left: `${p * 100}%`, transform: `translateX(${p <= 0.001 ? "0" : p >= reach - 0.001 ? "-100%" : "-50%"})` }}
              >
                {tk.label}
              </span>
            );
          })}
        </div>
        <span className="hidden truncate @md:block">{headers.wall}</span>
        <span className="hidden text-right @2xl:block">{headers.perUser}</span>
        <span className="text-right">{headers.verdict}</span>
      </div>
      {rows.map((r) => {
        const a = r.lo <= axis.min ? 0 : pos(r.lo);
        const b = pos(r.hi);
        const g = r.now >= r.lo ? pos(Math.min(r.now, r.hi)) : a;
        const labelAfter = a < 0.12;
        return (
          <button
            key={r.name}
            type="button"
            onClick={() => onSelect(r.name)}
            aria-pressed={r.selected}
            title={r.title}
            className={cn(
              GRID,
              "min-h-9 w-full border-b border-border/60 text-left outline-none transition-colors last:border-b-0",
              "hover:bg-muted/50 focus-visible:bg-muted/60",
              r.selected && "bg-info-soft/50 hover:bg-info-soft/60",
            )}
          >
            <span className={cn("truncate font-mono text-xs font-semibold", r.selected ? "text-info-fg" : "text-foreground")}>
              {r.name}
            </span>
            <span className="relative h-9">
              <span
                className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-muted-foreground/20"
                style={{ left: `${a * 100}%`, width: `max(0.5rem, ${(b - a) * 100}%)` }}
              />
              {g > a && (
                <span
                  className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-ok/80"
                  style={{ left: `${a * 100}%`, width: `${(g - a) * 100}%` }}
                />
              )}
              {rangeLabels && (
                <span
                  className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-xs text-muted-foreground"
                  style={labelAfter ? { left: `calc(${b * 100}% + 0.5rem)` } : { right: `calc(${(1 - a) * 100}% + 0.5rem)` }}
                >
                  {r.lo === r.hi ? r.hi : `${r.lo}–${r.hi}`}
                </span>
              )}
              {r.selected && r.marker !== undefined && (
                <span
                  className={cn(
                    "absolute top-1/2 h-3.5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-info-soft",
                    r.marker > r.now ? "bg-warn" : "bg-primary",
                  )}
                  style={{ left: `${pos(r.marker) * 100}%` }}
                />
              )}
            </span>
            <span className="hidden truncate font-mono text-xs text-foreground/80 @md:block">{r.wall}</span>
            <span className="hidden text-right font-mono text-xs text-foreground/80 @2xl:block">{r.perUser ?? "—"}</span>
            <span className="flex justify-end">{r.verdict && <Tag tone={r.verdict.tone}>{r.verdict.label}</Tag>}</span>
          </button>
        );
      })}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-muted/25 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="min-w-0">{footer}</span>
        <span className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-4 rounded-full bg-muted-foreground/20" />{legend.range}</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-4 rounded-full bg-ok/80" />{legend.now}</span>
        </span>
      </div>
    </div>
  );
}
