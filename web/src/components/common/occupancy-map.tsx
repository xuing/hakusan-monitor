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

const STRIP_H = 34;
const STRIP_MIN_W = 72;
// smallest tile that holds a name over an amount
const MIN_AREA = 84 * 54;

/** Tiles big enough for their text keep the squarified share of the box;
 *  the rest sit in a one-line strip along the bottom, side by side with
 *  proportional widths (at least STRIP_MIN_W), the tail merged into one
 *  tile when they do not all fit across. */
function layoutTiles(tiles: OccupancyTile[], w: number, h: number,
                     restLabel: (n: number, amount: number) => { label: string; amount: string }) {
  const total = tiles.reduce((sum, t) => sum + Math.max(0, t.value), 0);
  if (total <= 0 || w <= 0 || h <= 0) return [];
  const live = tiles.filter((t) => t.value > 0);
  const scale = (w * h) / total;
  const big = live.filter((t) => t.value * scale >= MIN_AREA);
  let small = live.filter((t) => t.value * scale < MIN_AREA);
  if (small.length === 0 || big.length === 0) return squarify(live, (t) => t.value, w, h);
  const top = squarify(big, (t) => t.value, w, h - STRIP_H);
  // merge the tail until every strip tile can be STRIP_MIN_W wide
  const fit = Math.max(1, Math.floor(w / STRIP_MIN_W));
  if (small.length > fit) {
    const kept = small.slice(0, fit - 1);
    const tail = small.slice(fit - 1);
    const sum = tail.reduce((a, t) => a + t.value, 0);
    const { label, amount } = restLabel(tail.length, sum);
    small = [...kept, { key: "~rest", value: sum, kind: "user", label, amount, details: tail.map((t) => `${t.label ?? t.amount} ${t.label ? t.amount : ""}`.trim()) }];
  }
  const sum = small.reduce((a, t) => a + t.value, 0);
  const free = w - STRIP_MIN_W * small.length;
  let x = 0;
  const strip = small.map((t) => {
    const tw = STRIP_MIN_W + (free * t.value) / sum;
    const r = { item: t, x, y: h - STRIP_H, w: tw, h: STRIP_H };
    x += tw;
    return r;
  });
  return [...top, ...strip];
}

/**
 * The pool as one box, each tile's area its share: who holds how much is the
 * first thing seen; cores, memory and jobs come up on hover (or a tap).
 */
export function OccupancyMap({ tiles, ariaLabel, restLabel, className }: {
  tiles: OccupancyTile[];
  ariaLabel: string;
  /** "其余 {n} 位" for strip tiles merged when they do not fit across */
  restLabel: (n: number, amount: number) => { label: string; amount: string };
  className?: string;
}) {
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
  const rects = layoutTiles(tiles, size.w, size.h, restLabel);
  return (
    <div
      ref={ref}
      role="img"
      aria-label={ariaLabel}
      className={cn("relative aspect-[16/9] w-full overflow-hidden rounded-lg", className)}
      onMouseLeave={() => setTip(null)}
    >
      {rects.map(({ item: t, x, y, w, h }) => {
        const strip = h <= STRIP_H + 0.5 && y >= size.h - STRIP_H - 0.5;
        const roomy = !strip && w > 84 && h > 62;
        const named = w > 40 && h > 22;
        // room for the whole hover card inside the tile
        const full = !strip && w > 150 && h > 104;
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
            {strip ? (
              // one line: who and how much
              <div className="truncate whitespace-nowrap">
                {t.label && <span className="font-mono font-semibold">{t.label} </span>}
                <span className={t.label ? "opacity-85" : "font-semibold"}>{t.amount}</span>
                {!t.label && t.sub && <span className="opacity-85"> {t.sub}</span>}
              </div>
            ) : (
              <>
                {t.label && named && <div className="truncate font-mono font-semibold">{t.label}</div>}
                {roomy && <div className="whitespace-nowrap text-sm font-bold">{t.amount}</div>}
                {roomy && !full && t.sub && <div className="whitespace-nowrap opacity-85">{t.sub}</div>}
                {full && t.details.map((d) => <div key={d} className="truncate opacity-90">{d}</div>)}
              </>
            )}
            {t.queued && <span aria-hidden className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-warn" />}
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
