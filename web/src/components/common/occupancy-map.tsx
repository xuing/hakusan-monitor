import { useEffect, useRef, useState } from "react";
import { squarify } from "@/lib/treemap";
import { cn } from "@/lib/utils";

export interface OccupancyTile {
  key: string;
  /** GPUs or cores: the tile's area */
  value: number;
  kind: "user" | "free" | "off";
  /** the user name; free / off tiles have none */
  label?: string;
  /** "7 GPU", "6,913 核" */
  amount: string;
  /** a second line when there is room ("5 节点") */
  sub?: string;
  /** the user still has jobs waiting here */
  queued?: boolean;
  /** shown on hover / tap */
  details: string[];
}

// one blue for every user (the gaps between tiles separate them), green
// free, gray offline — the same meanings as every bar on the page

/**
 * The pool as one box, each tile's area its share: who holds how much is the
 * first thing seen; cores, memory and jobs come up on hover (or a tap).
 */
export function OccupancyMap({ tiles, ariaLabel, className }: { tiles: OccupancyTile[]; ariaLabel: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tip, setTip] = useState<{ tile: OccupancyTile; x: number; y: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const rects = squarify(tiles, (t) => t.value, size.w, size.h);
  return (
    <div
      ref={ref}
      role="img"
      aria-label={ariaLabel}
      className={cn("relative aspect-[16/9] w-full overflow-hidden rounded-lg", className)}
      onMouseLeave={() => setTip(null)}
    >
      {rects.map(({ item: t, x, y, w, h }) => {
        const roomy = w > 84 && h > 54;
        const named = w > 40 && h > 22;
        const show = (e: { clientX: number; clientY: number }) => setTip({ tile: t, x: e.clientX, y: e.clientY });
        return (
          <div
            key={t.key}
            tabIndex={0}
            aria-label={[t.label, t.amount, ...t.details].filter(Boolean).join(", ")}
            onMouseMove={show}
            onClick={show}
            onFocus={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setTip({ tile: t, x: r.left + r.width / 2, y: r.top + r.height / 2 });
            }}
            onBlur={() => setTip(null)}
            className={cn(
              "absolute overflow-hidden rounded-md border-2 border-card px-2 py-1.5 text-xs leading-snug outline-none transition-[filter]",
              "hover:brightness-110 focus-visible:brightness-110",
              t.kind === "user" && "bg-info text-white",
              t.kind === "free" && "bg-ok text-white",
              t.kind === "off" && "bg-muted-foreground/30 text-foreground",
            )}
            style={{ left: x, top: y, width: w, height: h }}
          >
            {t.kind === "user" ? (
              <>
                {named && <div className="truncate font-mono font-semibold">{t.label}</div>}
                {roomy && <div className="whitespace-nowrap text-sm font-bold">{t.amount}</div>}
                {roomy && t.sub && <div className="whitespace-nowrap opacity-85">{t.sub}</div>}
                {t.queued && <span aria-hidden className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-warn" />}
              </>
            ) : (
              roomy && (
                <>
                  <div className="whitespace-nowrap text-sm font-bold">{t.amount}</div>
                  {t.sub && <div className="whitespace-nowrap opacity-85">{t.sub}</div>}
                </>
              )
            )}
          </div>
        );
      })}
      {tip && (
        <div
          className="pointer-events-none fixed z-50 max-w-xs rounded-md bg-primary px-3 py-2 text-xs leading-relaxed text-primary-foreground shadow-md"
          style={{ left: Math.min(tip.x + 14, window.innerWidth - 260), top: tip.y + 14 }}
        >
          {tip.tile.label && <div className="font-mono font-semibold">{tip.tile.label}</div>}
          <div>{tip.tile.amount}</div>
          {tip.tile.details.map((d) => <div key={d}>{d}</div>)}
        </div>
      )}
    </div>
  );
}
