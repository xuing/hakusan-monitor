import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface SliderTick {
  value: number;
  label: string;
}

/**
 * One request parameter: label + value box on top, a track whose green part
 * is "starts now" (from `min` to `green`), the scale's ticks, and an optional
 * hint line. The thumb turns amber past the green part, the moment the
 * request starts queueing.
 *
 * Dragging goes through a transparent native range input laid over the
 * drawn track (keyboard and screen readers keep working); values snap to
 * `snaps` (the default, the no-queue limit, …) when the thumb passes near
 * them, otherwise they are rounded by `quantize`.
 */
export function RangeSlider({
  label,
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
}: {
  label: ReactNode;
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
        <span className="inline-flex items-center gap-1 text-xs text-foreground/80">
          {label}
          {locked && <Lock aria-hidden className="h-3 w-3 text-muted-foreground" />}
        </span>
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
        <div
          className={cn(
            "pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 bg-background shadow-sm transition-colors",
            "peer-focus-visible:ring-2 peer-focus-visible:ring-primary/45",
            locked ? "border-muted-foreground/45" : queued ? "border-warn" : "border-primary",
          )}
          style={{ left: `${valuePos * 100}%` }}
        />
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
  if (!locked) return body;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent className="max-w-xs leading-relaxed">{locked}</TooltipContent>
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
