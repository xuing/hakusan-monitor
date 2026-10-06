import type { ReactNode } from "react";
import { Info, Lock } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { SliderTick } from "@/lib/request-input";

export type { SliderTick };

/** A request field's name: the name itself, then the Slurm flag it sets and
 *  any qualifier ("per node") in the secondary style, then extras (🔗). */
export function FieldLabel({ label, flag, qualifier, children }: {
  label: ReactNode;
  flag?: string;
  qualifier?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {flag && <code className="font-mono text-xs text-muted-foreground">{flag}</code>}
      {qualifier && <span className="text-xs text-muted-foreground">{qualifier}</span>}
      {children}
    </span>
  );
}

/** A field's explanatory note: secondary text behind an info mark, so it
 *  never reads as a label or a warning. */
export function FieldNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-start gap-1 text-xs leading-snug text-muted-foreground", className)}>
      <Info aria-hidden className="mt-0.5 h-3 w-3 shrink-0 opacity-70" />
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/**
 * One request parameter: label + value box on top, a track, the scale's
 * ticks, and an optional hint line. With the other fields as they are, the
 * green part (`min`…`green`) starts now and the amber rest is allowed but
 * queues; `green` below `min` paints all of it amber. No `green` = not
 * judged (no live data, or a command that is refused): a plain track. The
 * thumb turns amber past the green part, the moment the request queues.
 *
 * Dragging goes through a transparent native range input laid over the
 * drawn track (keyboard and screen readers keep working); values snap to
 * `snaps` (the default, the no-queue limit, …) when the thumb passes near
 * them, otherwise they are rounded by `quantize`.
 */
export function RangeSlider({
  label,
  flag,
  qualifier,
  labelExtra,
  min,
  max,
  value,
  onChange,
  scale = "linear",
  quantize = Math.round,
  snaps = [],
  green,
  greenLabel,
  ticks,
  valueBox,
  hint,
  error,
  ariaLabel,
  locked,
  tip,
  thumb = true,
}: {
  label: ReactNode;
  /** the Slurm flag the field sets ("--mem", "-t") */
  flag?: string;
  /** "per node" and the like */
  qualifier?: ReactNode;
  /** controls after the label (the 🔗 toggle) */
  labelExtra?: ReactNode;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
  scale?: "linear" | "log";
  quantize?: (value: number) => number;
  snaps?: number[];
  /** upper end of the starts-now part; undefined = no such part is drawn */
  green?: number;
  /** label under the green part's end (e.g. "224"), when it ends inside */
  greenLabel?: string;
  ticks: SliderTick[];
  valueBox: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  ariaLabel: string;
  /** shown, not editable: the value is fixed elsewhere; hovering says why */
  locked?: ReactNode;
  /** a hover note on an editable slider */
  tip?: ReactNode;
  /** false: the field has no single value on this scale right now (the
   *  track still sets one) */
  thumb?: boolean;
}) {
  const span = Math.max(max - min, 1e-9);
  const logSpan = Math.log(Math.max(max, 1e-9) / Math.max(min, 1e-9)) || 1;
  const pos = (v: number) => {
    const c = Math.min(max, Math.max(min, v));
    return scale === "log" ? Math.log(c / min) / logSpan : (c - min) / span;
  };
  const inv = (p: number) => (scale === "log" ? min * Math.exp(p * logSpan) : min + p * span);
  const pick = (p: number) => {
    const near = snaps
      .filter((s) => s >= min && s <= max)
      .map((s) => ({ s, d: Math.abs(pos(s) - p) }))
      .sort((a, b) => a.d - b.d)[0];
    const v = near && near.d < 0.025 ? near.s : quantize(inv(p));
    return Math.min(max, Math.max(min, v));
  };
  const hasZone = green !== undefined && !locked;
  const greenPos = hasZone ? (green! < min ? 0 : pos(green!)) : 0;
  const queued = hasZone && value > (green ?? Number.POSITIVE_INFINITY);
  const valuePos = pos(value);
  const showGreenMark = hasZone && green! >= min && green! < max;

  // ticks: ends anchored to the edges; drop any that would collide with the
  // green end's own label
  const placed = ticks
    .filter((tk) => tk.value >= min && tk.value <= max)
    .map((tk) => ({ ...tk, p: pos(tk.value) }))
    .filter((tk) => !(showGreenMark && greenLabel && Math.abs(tk.p - greenPos) < 0.15));

  const body = (
    <div className={cn("flex min-w-0 flex-col gap-1.5", locked && "cursor-not-allowed rounded-md outline-none focus-visible:ring-2 focus-visible:ring-primary/45")} tabIndex={locked ? 0 : undefined}>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel label={label} flag={flag} qualifier={qualifier}>
          {labelExtra}
          {locked && <Lock aria-hidden className="h-3 w-3 text-muted-foreground" />}
        </FieldLabel>
        {valueBox}
      </div>
      <div className="relative h-5">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-muted-foreground/15" />
        {/* past the green part, within bounds: allowed, but it queues */}
        {hasZone && greenPos < 1 && (
          <div className="absolute right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-warn/45" style={{ width: `${(1 - greenPos) * 100}%` }} />
        )}
        {hasZone && greenPos > 0 && (
          <div className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-ok/80" style={{ width: `${greenPos * 100}%` }} />
        )}
        {showGreenMark && (
          <div className="absolute top-1/2 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ok" style={{ left: `${greenPos * 100}%` }} />
        )}
        <input
          type="range"
          min={0}
          max={1000}
          step={1}
          value={Math.round(valuePos * 1000)}
          onChange={(e) => onChange(pick(Number(e.target.value) / 1000))}
          aria-label={ariaLabel}
          aria-valuetext={String(value)}
          disabled={Boolean(locked)}
          className={cn("peer absolute inset-0 z-10 h-full w-full opacity-0", locked ? "pointer-events-none" : "cursor-pointer")}
        />
        {thumb && (
          <div
            className={cn(
              "pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-background shadow-sm transition-colors",
              "peer-focus-visible:ring-2 peer-focus-visible:ring-primary/45",
              locked ? "border-muted-foreground/45" : queued ? "border-warn" : "border-primary",
            )}
            style={{ left: `${valuePos * 100}%` }}
          />
        )}
      </div>
      <div className="relative h-4 font-mono text-xs text-muted-foreground">
        {placed.map((tk, i) => (
          <span
            key={`${tk.value}-${i}`}
            className="absolute whitespace-nowrap"
            style={{ left: `${tk.p * 100}%`, transform: `translateX(${tk.p <= 0.001 ? "0" : tk.p >= 0.999 ? "-100%" : "-50%"})` }}
          >
            {tk.label}
          </span>
        ))}
        {showGreenMark && greenLabel && (
          <span
            className="absolute whitespace-nowrap font-semibold text-ok-fg"
            style={{ left: `${greenPos * 100}%`, transform: "translateX(-50%)" }}
          >
            {greenLabel}
          </span>
        )}
      </div>
      {error ? <p className="text-xs leading-snug text-bad-fg">{error}</p> : hint ? <p className="text-xs leading-snug text-warn-fg">{hint}</p> : null}
    </div>
  );
  const note = locked ?? tip;
  if (!note) return body;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent className="max-w-xs leading-relaxed">{note}</TooltipContent>
    </Tooltip>
  );
}

/** The read-only value beside a locked slider's label. */
export function SliderValueFixed({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-6 items-center rounded-md border border-dashed border-border px-2 font-mono text-xs font-semibold text-muted-foreground">
      {children}
    </span>
  );
}

/** The small value box beside a slider's label: shows the default as a
 *  placeholder until the user types or drags. */
export function SliderValueInput({
  value,
  placeholder,
  onChange,
  ariaLabel,
  invalid,
  width = "w-16",
}: {
  value: string;
  placeholder: string;
  onChange: (text: string) => void;
  ariaLabel: string;
  invalid?: boolean;
  width?: string;
}) {
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      inputMode="text"
      className={cn(
        "h-6 rounded-md border bg-muted/40 px-2 text-right font-mono text-xs font-semibold text-foreground outline-none",
        "placeholder:font-semibold placeholder:text-muted-foreground focus:border-primary",
        invalid ? "border-bad" : "border-border",
        width,
      )}
    />
  );
}
