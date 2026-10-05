import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { HoverHint } from "@/components/common/hover-hint";
import { SectionCard } from "@/components/common/section-card";
import { cn } from "@/lib/utils";

/** SectionCard with the analytics header: title, "*" method note, scope line,
 *  then the one-sentence finding that leads the card. */
export function AnCard({
  title,
  hint,
  extra,
  finding,
  className,
  children,
}: {
  title: string;
  hint: string;
  extra?: ReactNode;
  finding?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <SectionCard
      className={cn("h-full", className)}
      title={
        <span className="inline-flex items-center">
          {title}
          <HoverHint text={hint} className="ml-0.5" />
        </span>
      }
      extra={extra}
      bodyClassName="flex flex-col gap-3"
    >
      {finding && <p className="text-sm leading-relaxed text-foreground">{finding}</p>}
      {children}
    </SectionCard>
  );
}

export interface Segment {
  value: number;
  color: string;
  ink?: string;
  label?: string;
  title: string;
}

const GAP_PX = 2;
const CHAR_PX = 7.5;   // 12px semibold digits / %
const PAD_PX = 12;

/** 100% stacked bar: 2px surface gaps, rounded outer ends. A segment shows its
 *  label only when the measured segment is wide enough — never clipped. */
export function StackedBar({ segments, className }: { segments: Segment[]; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(el.getBoundingClientRect().width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const shown = segments.filter((s) => s.value > 0);
  const total = shown.reduce((a, s) => a + s.value, 0) || 1;
  const free = Math.max(0, width - GAP_PX * (shown.length - 1));
  return (
    <div ref={ref} className={cn("flex h-5 min-w-0 gap-[2px]", className)}>
      {shown.map((s, i) => {
        const fits = !!s.label && (s.value / total) * free >= s.label.length * CHAR_PX + PAD_PX;
        return (
          <div
            key={i}
            title={s.title}
            className={cn(
              "flex min-w-0 items-center justify-center whitespace-nowrap text-xs font-semibold",
              i === 0 && "rounded-l-[4px]",
              i === shown.length - 1 && "rounded-r-[4px]",
            )}
            style={{ flex: `${s.value} 1 0px`, background: s.color, color: s.ink }}
          >
            {fits ? s.label : null}
          </div>
        );
      })}
    </div>
  );
}

export function Legend({ items, className }: { items: { label: string; color: string }[]; className?: string }) {
  return (
    <div className={cn("flex flex-wrap gap-x-3.5 gap-y-1", className)}>
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

export function Dot({ color, className }: { color: string; className?: string }) {
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", className)} style={{ background: color }} />;
}

/** Hour ticks (0, 3, …, 21) under a 24-column grid with the given template. */
export function HourAxis({ columns }: { columns: string }) {
  return (
    <div className="mt-1 grid gap-x-[2px]" style={{ gridTemplateColumns: columns }}>
      <span />
      {Array.from({ length: 24 }, (_, h) => (
        <span key={h} className="tnum text-center text-xs text-muted-foreground">
          {h % 3 === 0 ? h : ""}
        </span>
      ))}
      <span />
    </div>
  );
}

/** Low→high swatches of a sequential ramp with its end labels. */
export function RampLegend({ colors, from, to }: { colors: string[]; from: string; to: string }) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span>{from}</span>
      <span className="flex gap-[2px]">
        {colors.map((c, i) => (
          <span key={i} className="h-2.5 w-2.5 rounded-sm" style={{ background: c }} />
        ))}
      </span>
      <span>{to}</span>
    </div>
  );
}
