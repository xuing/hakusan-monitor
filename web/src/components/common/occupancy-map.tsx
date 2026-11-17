import { useEffect, useRef, useState, type ReactNode } from "react";
import { cellParts, gridDims, packRects } from "@/lib/gpu-grid";
import { squarify } from "@/lib/treemap";
import { cn } from "@/lib/utils";

export interface OccupancyTile {
  key: string;
  /** GPUs or cores: the tile's area */
  value: number;
  kind: "user" | "free" | "reserved" | "off";
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
  /** units per node, where the tile spans nodes: on a grid one node's
   *  cells are drawn as one piece, a faint line only between nodes */
  parts?: NodePart[];
  /** "排队 3 个作业": the user still has jobs waiting (with queued) */
  queuedText?: string;
  /** the tiles a merged "others" tile stands for */
  members?: OccupancyTile[];
}

/** One node's share of a tile. */
export interface NodePart {
  n: number;
  /** jobs holding several GPUs on this node, in order: their GPUs come
   *  first along the piece, hatched, one stripe direction per job */
  multi?: { id: number | string; n: number }[];
  /** hover lines for a cell of this node: the node, then its jobs */
  lines?: string[];
}

type Tip = { tile: OccupancyTile; lines?: string[]; x: number; y: number };

/** Does a filter fade this tile? A merged "others" tile stays lit while any
 *  user in it passes. */
const faded = (t: OccupancyTile, highlight?: (t: OccupancyTile) => boolean) =>
  !!highlight && !(t.members ?? [t]).some(highlight);

/** A user's own tile, not the strip's merged "others". */
const pickable = (t: OccupancyTile) => t.kind === "user" && t.key !== "~rest";

/** A line of facts, its numbers set in the tile's strong text so they are
 *  read first, the words around them the same ink, faded: quieter than the
 *  name and count above, without a second colour competing with them. */
function Facts({ text, hue, className }: { text: string; hue: string; className?: string }) {
  const bits = text.split(/(\d[\d,.]*)/);
  return (
    <div className={cn("truncate", className)} style={{ color: `color-mix(in oklab, var(--${hue}-12) 74%, transparent)` }}>
      {bits.map((b, i) => (i % 2 ? <span key={i} className="tnum font-semibold" style={{ color: `var(--${hue}-12)` }}>{b}</span> : b))}
    </div>
  );
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
    small = [...kept, { key: "~rest", value: sum, kind: "user", label, amount, members: tail, details: tail.map((t) => `${t.label ?? t.amount} ${t.label ? t.amount : ""}`.trim()) }];
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

/** The grid for these tiles, or null where a grid does not apply (no whole
 *  units, too many cells, users that do not fit). */
function gridLayout(tiles: OccupancyTile[]) {
  const items = tiles
    .filter((t) => t.value > 0)
    // one node's idle GPUs stay in one piece
    .map((t) => ({ ...t, n: t.value, filler: t.kind !== "user", whole: t.kind !== "user" && !!t.parts }));
  if (items.some((t) => !Number.isInteger(t.n))) return null;
  const total = items.reduce((a, t) => a + t.n, 0);
  if (total === 0 || total > 400) return null;
  const [cols, rows] = gridDims(total);
  const packed = packRects(items, cols, rows);
  return packed ? { ...packed, cols, rows } : null;
}

/** One cell per GPU in a columns × rows grid; each owner a rectangle where
 *  the counts allow it, thick gaps between owners, faint lines between one
 *  owner's nodes (a node's GPUs read as one piece), hatching where one job
 *  holds several GPUs of a node. The text sits over the block's
 *  rectangle and says as much as fits: name, count, nodes, then the hover
 *  card's lines. */
function CellGrid({ tiles, ariaLabel, dashed, multiLabel, onPick, highlight, className }: {
  tiles: OccupancyTile[]; ariaLabel: string; dashed?: boolean; multiLabel?: string; onPick?: (t: OccupancyTile) => void;
  highlight?: (t: OccupancyTile) => boolean; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tip, setTip] = useState<Tip | null>(null);
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
  // the node each cell sits on: a tile with parts keeps a node's cells
  // together; one without has every cell on its own
  const part: number[][] = Array.from({ length: cols }, () => Array<number>(rows).fill(-1));
  const info: (NodePart | undefined)[][] = Array.from({ length: cols }, () => Array<NodePart | undefined>(rows));
  // the stripe direction of a cell held by a multi-GPU job (0 or 1), else -1:
  // jobs alternate directions within an owner, so two jobs side by side
  // differ and one job across nodes keeps one direction
  const multi: number[][] = Array.from({ length: cols }, () => Array<number>(rows).fill(-1));
  let nextPart = 0;
  for (const t of tiles) {
    const mine: [number, number][] = [];
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) if (grid[c][r]?.key === t.key) mine.push([c, r]);
    const split = t.parts ? cellParts(mine, t.parts.map((p) => p.n)) : { part: mine.map((_, i) => i), rank: mine.map(() => 0) };
    const jobOf = (p: NodePart | undefined, rank: number) => {
      let at = 0;
      for (const j of p?.multi ?? []) {
        at += j.n;
        if (rank < at) return String(j.id);
      }
      return null;
    };
    const order = new Map<string, number>();
    mine.forEach(([c, r], i) => {
      const p = t.parts?.[split.part[i]];
      part[c][r] = nextPart + split.part[i];
      info[c][r] = p;
      const job = t.kind === "user" ? jobOf(p, split.rank[i]) : null;
      if (job !== null) {
        if (!order.has(job)) order.set(job, order.size);
        multi[c][r] = order.get(job)! % 2;
      }
    });
    nextPart += mine.length + (t.parts?.length ?? 0);
  }
  const anyMulti = multi.some((col) => col.some((m) => m >= 0));
  const cw = size.w / cols;
  const ch = size.h / rows;
  const cells: ReactNode[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const it = grid[c][r];
      if (!it) continue;
      const show = (e: { clientX: number; clientY: number }) => setTip({ tile: it, lines: info[c][r]?.lines, x: e.clientX, y: e.clientY });
      // a faint line where the cell meets another node of the same owner
      const lineL = c > 0 && grid[c - 1][r]?.key === it.key && part[c - 1][r] !== part[c][r];
      const lineT = r > 0 && grid[c][r - 1]?.key === it.key && part[c][r - 1] !== part[c][r];
      cells.push(
        <div
          key={`${c}-${r}`}
          onMouseMove={show}
          onClick={(e) => (onPick && pickable(it) ? onPick(it) : show(e))}
          className={cn(
            "min-w-0 transition-opacity",
            onPick && pickable(it) && "cursor-pointer",
            faded(it, highlight) && FADED,
            TONE[it.kind],
            dashed && CELL_DASH[it.kind],
            c > 0 && grid[c - 1][r]?.key !== it.key && "border-l-4 border-l-card",
            r > 0 && grid[c][r - 1]?.key !== it.key && "border-t-4 border-t-card",
          )}
          style={{
            gridColumn: c + 1,
            gridRow: r + 1,
            // one hatch for the whole grid, each cell showing its slice of
            // it, so the lines run on across a node's cells without a seam
            ...(multi[c][r] >= 0 && size.w > 0
              ? { backgroundImage: MULTI_HATCH[multi[c][r]], backgroundSize: `${size.w}px ${size.h}px`, backgroundPosition: `${-c * cw}px ${-r * ch}px`, backgroundOrigin: "border-box" }
              : {}),
            boxShadow: !dashed && (lineL || lineT) ? `inset ${lineL ? 1 : 0}px ${lineT ? 1 : 0}px 0 var(--${HUE[it.kind]}-7)` : undefined,
          }}
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
        aria-label={[t.label, t.amount, ...t.details, t.queuedText].filter(Boolean).join(", ")}
        onFocus={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setTip({ tile: t, x: r.left + r.width / 2, y: r.top + r.height / 2 });
        }}
        onBlur={() => setTip(null)}
        onKeyDown={(e) => {
          if (onPick && pickable(t) && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            onPick(t);
          }
        }}
        className={cn(
          "pointer-events-none relative z-[1] min-w-0 overflow-hidden px-2 py-1.5 text-xs leading-tight outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-primary/60",
          TONE[t.kind].split(" ")[1],
          faded(t, highlight) && FADED,
        )}
        style={{
          gridColumn: `${b.c + 1} / span ${b.w}`,
          gridRow: `${b.r + 1} / span ${b.h}`,
          // a halo in the tile's fill keeps the text clear of hatching and lines
          textShadow: `0 0 6px var(--${HUE[t.kind]}-4), 0 0 2px var(--${HUE[t.kind]}-4)`,
        }}
      >
        {t.kind === "user" ? (
          <>
            {named && <div className="truncate pe-3 font-mono font-semibold">{t.label}</div>}
            {roomy && <div className="tnum mt-0.5 truncate text-sm font-bold">{t.amount}</div>}
            {withSub && !full && t.sub && <Facts text={t.sub} hue={HUE[t.kind]} className="mt-1" />}
            {full && (
              <div className="mt-1 space-y-px">
                {t.details.map((d) => <Facts key={d} text={d} hue={HUE[t.kind]} />)}
                {t.queuedText && <Facts text={t.queuedText} hue="amber" />}
              </div>
            )}
          </>
        ) : (
          named && (
            <>
              <div className="truncate font-semibold">{t.sub}</div>
              {roomy && <div className="truncate opacity-90">{t.amount}</div>}
            </>
          )
        )}
        {t.queued && <span aria-hidden className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-warn ring-2 ring-[var(--blue-4)]" />}
      </div>,
    );
  }
  return (
    <>
      <div
        ref={ref}
        role="img"
        aria-label={ariaLabel}
        onMouseLeave={() => setTip(null)}
        dir="ltr"
        className={cn("relative grid aspect-[16/9] w-full overflow-hidden rounded-lg", className)}
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}
      >
        {cells}
        {labels}
        {tip && <TipCard tip={tip} />}
      </div>
      {/* the hatching is explained only where it shows */}
      {anyMulti && multiLabel && (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden className="h-3.5 w-3.5 rounded-[3px] border border-[var(--blue-7)] bg-[var(--blue-4)]" style={{ backgroundImage: MULTI_HATCH[0] }} />
          {multiLabel}
        </div>
      )}
    </>
  );
}

function TipCard({ tip }: { tip: Tip }) {
  return (
    <div
      className="pointer-events-none fixed z-50 max-w-xs rounded-md bg-primary px-3 py-2 text-xs leading-relaxed text-primary-foreground shadow-md"
      style={{ left: Math.min(tip.x + 14, window.innerWidth - 260), top: tip.y + 14 }}
    >
      {tip.tile.label && <div className="font-mono font-semibold">{tip.tile.label}</div>}
      <div>{tip.tile.amount}</div>
      {tip.tile.details.map((d) => <div key={d}>{d}</div>)}
      {tip.tile.queuedText && <div>{tip.tile.queuedText}</div>}
      {/* the cell under the pointer: its node and the jobs on it */}
      {tip.lines?.length ? (
        <div className="mt-1 border-t border-primary-foreground/25 pt-1">
          {tip.lines.map((l, i) => <div key={l} className={i === 0 ? "font-mono" : undefined}>{l}</div>)}
        </div>
      ) : null}
    </div>
  );
}

// one job holding several GPUs of a node: the same held blue (a new fill
// would read as another user), hatched with thin diagonal lines, the two
// directions telling neighbouring jobs apart
const hatch = (deg: number) => `repeating-linear-gradient(${deg}deg, transparent 0 7px, color-mix(in oklab, var(--blue-7) 26%, transparent) 7px 8px)`;
const MULTI_HATCH = [hatch(135), hatch(45)];

// a tile outside the current filter steps back; it stays readable and
// clickable, so the map still shows the whole pool
const FADED = "opacity-35";

// soft tints with dark text: large areas stay calm; the hue keeps its
// meaning (blue held, green free, amber held by the scheduler, gray offline)
// and Radix flips it in dark mode
const TONE = {
  user: "bg-[var(--blue-4)] text-[var(--blue-12)]",
  free: "bg-[var(--green-4)] text-[var(--green-12)]",
  reserved: "bg-[var(--amber-4)] text-[var(--amber-12)]",
  off: "bg-[var(--gray-4)] text-[var(--gray-11)]",
} as const;
const HOVER = {
  user: "hover:bg-[var(--blue-5)]",
  free: "hover:bg-[var(--green-5)]",
  reserved: "hover:bg-[var(--amber-5)]",
  off: "hover:bg-[var(--gray-5)]",
} as const;
const HUE = { user: "blue", free: "green", reserved: "amber", off: "gray" } as const;
// cores are many and small: a dashed hairline on the right and bottom edges
const CELL_DASH = {
  user: "border-b border-r border-dashed border-[var(--blue-7)]",
  free: "border-b border-r border-dashed border-[var(--green-7)]",
  reserved: "border-b border-r border-dashed border-[var(--amber-7)]",
  off: "border-b border-r border-dashed border-[var(--gray-7)]",
} as const;

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
export function OccupancyMap({ tiles, ariaLabel, restLabel, perRow, nodeWord = "", grid, dashed, multiLabel, onPick, highlight, className }: {
  tiles: OccupancyTile[];
  ariaLabel: string;
  /** cores of one node, where every job holds whole nodes: then one row per
   *  node, stacked, instead of a treemap */
  perRow?: number;
  /** "节点", after the node count each row block prints */
  nodeWord?: string;
  /** one cell per unit (a GPU, or a core on a small pool): countable */
  grid?: boolean;
  /** dashed lines between one owner's cells (cores, finer than GPUs) */
  dashed?: boolean;
  /** "其余 {n} 位" for strip tiles merged when they do not fit across */
  restLabel: (n: number, amount: number) => { label: string; amount: string };
  /** "多卡作业": the legend for the hatching, shown when a grid has it */
  multiLabel?: string;
  /** a click (or Enter) on a user's tile, in place of the hover card */
  onPick?: (t: OccupancyTile) => void;
  /** when set, the tiles it turns down fade (a filter the map stands for) */
  highlight?: (t: OccupancyTile) => boolean;
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
  if (grid && gridLayout(tiles)) return <CellGrid tiles={tiles} ariaLabel={ariaLabel} dashed={dashed} multiLabel={multiLabel} onPick={onPick} highlight={highlight} className={className} />;
  const rects = perRow ? layoutRows(tiles, size.w, size.h, perRow) : layoutTiles(tiles, size.w, size.h, restLabel);
  return (
    <div
      ref={ref}
      role="img"
      aria-label={ariaLabel}
      dir="ltr"
      className={cn("relative aspect-[16/9] w-full overflow-hidden rounded-lg", className)}
      onMouseLeave={() => setTip(null)}
    >
      {rects.map(({ item: t, x, y, w, h }) => {
        const strip = perRow ? true : h <= STRIP_H + 0.5 && y >= size.h - STRIP_H - 0.5;
        // one faint line per node inside a block of several
        const nodes = perRow ? Math.max(1, Math.round(t.value / perRow)) : 1;
        const lines = nodes > 1
          ? { backgroundImage: `repeating-linear-gradient(to bottom, transparent 0, transparent ${h / nodes - 1}px, var(--${HUE[t.kind]}-6) ${h / nodes - 1}px, var(--${HUE[t.kind]}-6) ${h / nodes}px)` }
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
            aria-label={[t.label, t.amount, ...t.details, t.queuedText].filter(Boolean).join(", ")}
            onMouseMove={show}
            onClick={(e) => (onPick && pickable(t) ? onPick(t) : show(e))}
            onKeyDown={(e) => {
              if (onPick && pickable(t) && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                onPick(t);
              }
            }}
            onFocus={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setTip({ tile: t, x: r.left + r.width / 2, y: r.top + r.height / 2 });
            }}
            onBlur={() => setTip(null)}
            className={cn(
              "absolute overflow-hidden rounded-md border-2 border-card px-2 py-1.5 text-xs leading-snug outline-none transition-[filter,opacity]",
              TONE[t.kind],
              HOVER[t.kind],
              onPick && pickable(t) && "cursor-pointer",
              faded(t, highlight) && FADED,
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
                {roomy && <div className="tnum mt-0.5 whitespace-nowrap text-sm font-bold">{t.amount}</div>}
                {roomy && !full && t.sub && <Facts text={t.sub} hue={HUE[t.kind]} className="mt-1" />}
                {full && (
                  <div className="mt-1 space-y-px">
                    {t.details.map((d) => <Facts key={d} text={d} hue={HUE[t.kind]} />)}
                    {t.queuedText && <Facts text={t.queuedText} hue="amber" />}
                  </div>
                )}
              </>
            )}
            {t.queued && <span aria-hidden className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-warn ring-2 ring-[var(--blue-4)]" />}
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
          {tip.tile.queuedText && <div>{tip.tile.queuedText}</div>}
        </div>
      )}
    </div>
  );
}
