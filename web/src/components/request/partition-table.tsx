import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
  /** false: the row's command is refused as it stands — a plain bar, no
   *  starts-now / queues split */
  judged?: boolean;
  wall: string;
  /** the most jobs one user may run at once, as the cell shows it ("4 个作业") */
  perUser?: string;
  verdict: { tone: Tone; label: string } | null;
  selected: boolean;
  /** the selected row's current request, drawn on its bar */
  marker?: number;
  /** the partition's default request (no flags), ticked on every row */
  def?: number;
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
// text columns as wide as their words; the bar takes the rest
const GRID = "grid grid-cols-[6rem_minmax(0,1fr)_5.5rem] items-center gap-x-4 px-4 @md:grid-cols-[6.25rem_minmax(0,1fr)_4.5rem_5.5rem] @2xl:grid-cols-[6.5rem_minmax(0,1fr)_4.5rem_5.75rem_5.5rem] @2xl:gap-x-5";

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
  onPickValue,
  quantize = Math.round,
}: {
  rows: PartitionTableRow[];
  axis: PartitionAxis;
  onSelect: (name: string) => void;
  /** `axis`: what the bar counts ("张数"), said just before its ticks */
  headers: { name: string; axis: string; wall: string; perUser: string; verdict: string };
  legend: { range: string; now: string; def: string };
  footer?: ReactNode;
  /** "lo–hi" beside each bar; off where the axis already ticks every value */
  rangeLabels?: boolean;
  /** a click on a bar: pick that row with the value under the pointer */
  onPickValue?: (name: string, value: number) => void;
  quantize?: (value: number) => number;
}) {
  const logSpan = Math.log(axis.max / axis.min) || 1;
  // with range labels the axis uses 80% of the cell: a label after a bar that
  // starts at the axis origin always has room, and one before a bar that
  // starts further in sits in the empty part on its left
  const reach = rangeLabels ? 0.8 : 1;
  /** a value's place along the axis, 0 (min) … reach (max) */
  const pos = (v: number) => {
    const c = Math.min(axis.max, Math.max(axis.min, v));
    return reach * (axis.scale === "log" ? Math.log(c / axis.min) / logSpan : (c - axis.min) / Math.max(axis.max - axis.min, 1));
  };
  // The axis starts after a lead that holds its label (张数, 核数): the
  // label starts where the count bars start, the first tick sits clear of
  // it. A count bar from one GPU starts at the cell's edge, in the lead, so
  // a row whose green part is only that GPU still shows it. The
  // count axis keeps whole steps apart (2.75rem); the log axis, whose steps
  // are short, leads by just its label (measured, so every language fits)
  // with the first tick starting there.
  const labelRef = useRef<HTMLSpanElement>(null);
  const [labelPx, setLabelPx] = useState(0);
  useLayoutEffect(() => setLabelPx(labelRef.current?.offsetWidth ?? 0), [headers.axis]);
  const logAxis = axis.scale === "log";
  const leadPx = () => (logAxis && labelPx ? labelPx + 8 : 2.75 * parseFloat(getComputedStyle(document.documentElement).fontSize));
  const LEAD = logAxis && labelPx ? `${labelPx + 8}px` : "2.75rem";
  /** where a value sits, as a CSS length from the cell's left edge */
  const x = (v: number) => (v < axis.min ? "0px" : `calc(${LEAD} + (100% - ${LEAD}) * ${pos(v)})`);
  const inv = (px: number, width: number) => {
    const lead = leadPx();
    const q = Math.min(1, Math.max(0, (px - lead) / Math.max(width - lead, 1) / reach));
    return axis.scale === "log" ? axis.min * Math.exp(q * logSpan) : axis.min + q * (axis.max - axis.min);
  };
  return (
    <div className="@container overflow-hidden rounded-lg border border-border bg-card">
      <div className={cn(GRID, "border-b border-border bg-muted/40 py-2 text-xs text-muted-foreground")}>
        <span className="truncate">{headers.name}</span>
        <div className="relative h-4 font-mono">
          {/* what the ticks count, in the lead where the bars start */}
          <span ref={labelRef} className="absolute left-0 whitespace-nowrap font-sans">
            {headers.axis}
          </span>
          {axis.ticks.map((tk, i) => {
            const p = pos(tk.value);
            // a phone-width bar holds only the two ends
            const interior = i > 0 && i < axis.ticks.length - 1;
            return (
              <span
                key={tk.value}
                className={cn("absolute whitespace-nowrap", tk.minor ? "hidden @xl:inline" : interior && "hidden @sm:inline")}
                style={{ left: x(tk.value), transform: `translateX(${p >= reach - 0.001 ? "-100%" : logAxis && i === 0 ? "0" : "-50%"})` }}
              >
                {tk.label}
              </span>
            );
          })}
        </div>
        <span className="hidden truncate text-right @md:block">{headers.wall}</span>
        <span className="hidden whitespace-nowrap @2xl:block">{headers.perUser}</span>
        {/* one line: a long header (ja) runs into the gap on its left */}
        <span className="flex justify-end whitespace-nowrap">{headers.verdict}</span>
      </div>
      {rows.map((r) => {
        // a count bar from one GPU starts at the cell's edge, so one free GPU
        // shows; a core bar starts at its first core (one is never all that is left)
        const fromEdge = !logAxis && r.lo <= axis.min;
        const lo = fromEdge ? axis.min - 1 : r.lo;
        const a = r.lo <= axis.min ? 0 : pos(r.lo);
        const judged = r.judged !== false;
        const gv = judged && r.now >= r.lo ? Math.min(r.now, r.hi) : null;
        const g = gv !== null ? pos(gv) : a;
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
              "min-h-10 w-full border-b border-border/60 text-left outline-none transition-colors last:border-b-0",
              "hover:bg-muted/50 focus-visible:bg-muted/60",
              r.selected && "bg-info-soft/50 hover:bg-info-soft/60",
            )}
          >
            <span className={cn("truncate font-mono text-xs font-semibold", r.selected ? "text-info-fg" : "text-foreground")}>
              {r.name}
            </span>
            <span
              className={cn("relative h-9", onPickValue && "cursor-crosshair")}
              onClick={onPickValue ? (e) => {
                // the bar's own row, at the value under the pointer
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                const v = quantize(inv(e.clientX - rect.left, rect.width));
                onPickValue(r.name, Math.min(r.hi, Math.max(r.lo, v)));
              } : undefined}
            >
              <span
                className={cn("absolute top-1/2 h-2 -translate-y-1/2 rounded-full", judged ? "bg-warn/45" : "bg-muted-foreground/20")}
                style={{ left: x(lo), width: `max(0.5rem, calc(${x(r.hi)} - ${x(lo)}))` }}
              />
              {gv !== null && (fromEdge || g > a) && (
                <span
                  className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-ok/80"
                  style={{ left: x(lo), width: `calc(${x(gv)} - ${x(lo)})` }}
                />
              )}
              {rangeLabels && (
                <span
                  className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap font-mono text-xs text-muted-foreground"
                  style={labelAfter ? { left: `calc(${x(r.hi)} + 0.5rem)` } : { right: `calc(100% - ${x(lo)} + 0.5rem)` }}
                >
                  {r.lo === r.hi ? r.hi : `${r.lo}–${r.hi}`}
                </span>
              )}
              {r.def !== undefined && r.def >= r.lo && r.def <= r.hi && (
                <span
                  className="absolute top-1/2 h-2.5 w-px -translate-x-1/2 -translate-y-1/2 bg-foreground/30"
                  style={{ left: x(r.def) }}
                />
              )}
              {r.selected && r.marker !== undefined && (
                <span
                  className={cn(
                    "absolute top-1/2 h-3.5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-info-soft",
                    !judged ? "bg-muted-foreground" : r.marker > r.now ? "bg-warn" : "bg-primary",
                  )}
                  style={{ left: x(r.marker) }}
                />
              )}
            </span>
            <span className="hidden truncate text-right text-xs text-foreground/80 @md:block">{r.wall}</span>
            <span className="hidden whitespace-nowrap text-xs text-foreground/80 @2xl:block">{r.perUser ?? "—"}</span>
            <span className="flex justify-end">{r.verdict && <Tag tone={r.verdict.tone}>{r.verdict.label}</Tag>}</span>
          </button>
        );
      })}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 bg-muted/25 px-4 py-2 text-xs text-muted-foreground">
        <span className="min-w-0">{footer}</span>
        <span className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-px bg-foreground/30" />{legend.def}</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-4 rounded-full bg-warn/45" />{legend.range}</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-4 rounded-full bg-ok/80" />{legend.now}</span>
        </span>
      </div>
    </div>
  );
}
