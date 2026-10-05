import { useEffect, useRef, useState, type ReactNode } from "react";
import { gridDims, packRects } from "@/lib/gpu-grid";
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

/** One cell per GPU in a columns × rows grid; a user's cells form one block
 *  (whole columns plus a step), thick gaps between owners, faint lines between
 *  cells of the same owner. The name and count sit in the block's first cell. */
/** The grid for these tiles, or null where a grid does not apply (no whole
 *  units, too many cells, users that do not fit). */
function gridLayout(tiles: OccupancyTile[]) {
  const items = tiles
    .filter((t) => t.value > 0)
    .map((t) => ({ ...t, n: t.value, filler: t.kind !== "user" }));
  if (items.some((t) => !Number.isInteger(t.n))) return null;
  const total = items.reduce((a, t) => a + t.n, 0);
  if (total === 0 || total > 400) return null;
  const [cols, rows] = gridDims(total);
  const packed = packRects(items, cols, rows);
  return packed ? { ...packed, cols, rows } : null;
}

/** One cell per GPU in a columns × rows grid; each owner a rectangle where
 *  the counts allow it, thick gaps between owners, faint lines between one
 *  owner's cells. The text sits over the block's rectangle and says as much
 *  as fits: name, count, nodes, then the hover card's lines. */
function CellGrid({ tiles, ariaLabel, className }: { tiles: OccupancyTile[]; ariaLabel: string; className?: string }) {
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
  const layout = gridLayout(tiles);
  if (!layout) return null;
  const { grid, blocks, cols, rows } = layout;
  const cw = size.w / cols;
  const ch = size.h / rows;
  const cells: ReactNode[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const it = grid[c][r];
      if (!it) continue;
      const show = (e: { clientX: number; clientY: number }) => setTip({ tile: it, x: e.clientX, y: e.clientY });
      cells.push(
        <div
          key={`${c}-${r}`}
          onMouseMove={show}
          onClick={show}
          className={cn(
            "min-w-0 shadow-[inset_1px_1px_0_rgb(255_255_255/0.22)]",
            it.kind === "user" && "bg-info",
            it.kind === "free" && "bg-ok",
            it.kind === "off" && "bg-muted-foreground/30",
            c > 0 && grid[c - 1][r]?.key !== it.key && "border-l-4 border-card",
            r > 0 && grid[c][r - 1]?.key !== it.key && "border-t-4 border-card",
          )}
          style={{ gridColumn: c + 1, gridRow: r + 1 }}
        />,
      );
    }
  }
  const labels: ReactNode[] = [];
  for (const t of tiles) {
    const b = blocks.get(t.key);
    if (!b) continue;
    const w = b.w * cw;
    const h = b.h * ch;
    const named = w > 40 && h > 22;
    const roomy = w > 70 && h > 44;
    const withSub = w > 70 && h > 62;
    const full = w > 150 && h > 104;
    labels.push(
      <div
        key={t.key}
        tabIndex={0}
        aria-label={[t.label, t.amount, ...t.details].filter(Boolean).join(", ")}
        onFocus={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setTip({ tile: t, x: r.left + r.width / 2, y: r.top + r.height / 2 });
        }}
        onBlur={() => setTip(null)}
        className={cn(
          "pointer-events-none relative z-[1] min-w-0 overflow-hidden px-2 py-1.5 text-xs leading-snug outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
          t.kind === "off" ? "text-foreground" : "text-white",
        )}
        style={{ gridColumn: `${b.c + 1} / span ${b.w}`, gridRow: `${b.r + 1} / span ${b.h}` }}
      >
        {t.kind === "user" ? (
          <>
            {named && <div className="truncate font-mono font-semibold">{t.label}</div>}
            {roomy && <div className="truncate text-sm font-bold">{t.amount}</div>}
            {withSub && !full && t.sub && <div className="truncate opacity-85">{t.sub}</div>}
            {full && t.details.map((d) => <div key={d} className="truncate opacity-90">{d}</div>)}
          </>
        ) : (
          named && (
            <>
              <div className="truncate font-semibold">{t.sub}</div>
              {roomy && <div className="truncate opacity-90">{t.amount}</div>}
            </>
          )
        )}
        {t.queued && <span aria-hidden className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-warn" />}
      </div>,
    );
  }
  return (
    <div
      ref={ref}
      role="img"
      aria-label={ariaLabel}
      onMouseLeave={() => setTip(null)}
      className={cn("relative grid aspect-[16/9] w-full overflow-hidden rounded-lg", className)}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
    >
      {cells}
      {labels}
      {tip && <TipCard tip={tip} />}
    </div>
  );
}

function TipCard({ tip }: { tip: { tile: OccupancyTile; x: number; y: number } }) {
  return (
    <div
      className="pointer-events-none fixed z-50 max-w-xs rounded-md bg-primary px-3 py-2 text-xs leading-relaxed text-primary-foreground shadow-md"
      style={{ left: Math.min(tip.x + 14, window.innerWidth - 260), top: tip.y + 14 }}
    >
      {tip.tile.label && <div className="font-mono font-semibold">{tip.tile.label}</div>}
      <div>{tip.tile.amount}</div>
      {tip.tile.details.map((d) => <div key={d}>{d}</div>)}
    </div>
  );
}

const ROW_MIN_H = 30;

/** One row per node, top to bottom: users first, then free and offline. A
 *  user's rows keep at least ROW_MIN_H so a one-node job still reads; the
 *  rest share what is left in proportion to their nodes. */
function layoutRows(tiles: OccupancyTile[], w: number, h: number, perRow: number) {
  const live = tiles.filter((t) => t.value > 0);
  const nodesOf = (t: OccupancyTile) => Math.max(1, Math.round(t.value / perRow));
  const total = live.reduce((a, t) => a + nodesOf(t), 0);
  if (!total || w <= 0 || h <= 0) return [];
  const unit = h / total;
  const users = live.filter((t) => t.kind === "user");
  const rest = live.filter((t) => t.kind !== "user");
  const userH = users.map((t) => Math.max(ROW_MIN_H, nodesOf(t) * unit));
  let left = h - userH.reduce((a, b) => a + b, 0);
  const restNodes = rest.reduce((a, t) => a + nodesOf(t), 0);
  // too many users for their minimum: fall back to plain proportions
  const scale = left < 0 || (!rest.length && left !== 0) ? h / userH.reduce((a, b) => a + b, 0) : 1;
  if (scale !== 1) left = 0;
  let y = 0;
  const out: { item: OccupancyTile; x: number; y: number; w: number; h: number }[] = [];
  users.forEach((t, i) => {
    const th = userH[i] * scale;
    out.push({ item: t, x: 0, y, w, h: th });
    y += th;
  });
  for (const t of rest) {
    const th = restNodes ? (left * nodesOf(t)) / restNodes : 0;
    out.push({ item: t, x: 0, y, w, h: th });
    y += th;
  }
  return out;
}

/**
 * The pool as one box, each tile's area its share: who holds how much is the
 * first thing seen; cores, memory and jobs come up on hover (or a tap).
 */
export function OccupancyMap({ tiles, ariaLabel, restLabel, perRow, nodeWord = "", grid, className }: {
  tiles: OccupancyTile[];
  ariaLabel: string;
  /** cores of one node, where every job holds whole nodes: then one row per
   *  node, stacked, instead of a treemap */
  perRow?: number;
  /** "节点", after the node count each row block prints */
  nodeWord?: string;
  /** one cell per unit (a GPU): countable, packed by whole columns */
  grid?: boolean;
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
  if (grid && gridLayout(tiles)) return <CellGrid tiles={tiles} ariaLabel={ariaLabel} className={className} />;
  const rects = perRow ? layoutRows(tiles, size.w, size.h, perRow) : layoutTiles(tiles, size.w, size.h, restLabel);
  return (
    <div
      ref={ref}
      role="img"
      aria-label={ariaLabel}
      className={cn("relative aspect-[16/9] w-full overflow-hidden rounded-lg", className)}
      onMouseLeave={() => setTip(null)}
    >
      {rects.map(({ item: t, x, y, w, h }) => {
        const strip = perRow ? true : h <= STRIP_H + 0.5 && y >= size.h - STRIP_H - 0.5;
        // one faint line per node inside a block of several
        const nodes = perRow ? Math.max(1, Math.round(t.value / perRow)) : 1;
        const lines = nodes > 1
          ? { backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${h / nodes - 1}px, rgb(255 255 255 / 0.22) ${h / nodes - 1}px, rgb(255 255 255 / 0.22) ${h / nodes}px)` }
          : undefined;
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
            style={{ left: x, top: y, width: w, height: h, ...lines }}
          >
            {strip ? (
              // one line: who and how much
              <div className="truncate whitespace-nowrap">
                {t.label && <span className="font-mono font-semibold">{t.label} </span>}
                <span className={t.label ? "opacity-85" : "font-semibold"}>{t.amount}</span>
                {!t.label && t.sub && <span className="opacity-85"> {t.sub}</span>}
                {perRow && nodeWord && <span className="opacity-85"> · {nodes} {nodeWord}</span>}
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
