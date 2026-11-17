/** Columns × rows for n cells: the factor pair whose shape is closest to the
 *  map's 16:9 (40 → 8 × 5, 20 → 5 × 4, 4 → 2 × 2). */
export function gridDims(n: number, aspect = 16 / 9): [number, number] {
  let best: [number, number] = [Math.max(1, n), 1];
  let score = Number.POSITIVE_INFINITY;
  for (let r = 1; r <= n; r++) {
    if (n % r) continue;
    const c = n / r;
    const d = Math.abs(c / r - aspect);
    if (d < score) {
      score = d;
      best = [c, r];
    }
  }
  return best;
}

export interface GridItem {
  key: string;
  n: number;
  /** users are packed first; the rest fill what is left */
  filler?: boolean;
  /** a filler kept in one piece, like a user (one node's idle GPUs) */
  whole?: boolean;
}

/**
 * One cell per unit, packed so every user's block is a rectangle or a
 * rectangle with one step: a user takes whole columns, its remainder goes to
 * the top of the next column, and smaller users stack in that column's rest.
 * Fillers (free, offline) take the cells left over. grid[col][row]; null when
 * the users do not fit.
 */
export function packColumns<T extends GridItem>(items: T[], cols: number, rows: number): (T | null)[][] | null {
  const grid: (T | null)[][] = Array.from({ length: cols }, () => Array<T | null>(rows).fill(null));
  const queue = items.filter((i) => !i.filler && i.n > 0);
  const fillers = items.filter((i) => i.filler && i.n > 0);
  let col = 0;
  let row = 0;
  const put = (it: T) => {
    if (col >= cols) return false;
    grid[col][row] = it;
    row += 1;
    if (row === rows) {
      col += 1;
      row = 0;
    }
    return true;
  };
  while (queue.length) {
    const it = queue.shift()!;
    // fits in the open column: stack it there
    if (row > 0 && it.n <= rows - row) {
      for (let k = 0; k < it.n; k++) if (!put(it)) return null;
      continue;
    }
    if (row > 0) {
      col += 1;
      row = 0;
    }
    for (let k = 0; k < it.n; k++) if (!put(it)) return null;
    // the remainder opened a column: stack the largest small users under it
    if (row > 0) {
      for (let j = 0; j < queue.length && row > 0;) {
        const s = queue[j];
        if (s.n <= rows - row) {
          for (let k = 0; k < s.n; k++) put(s);
          queue.splice(j, 1);
        } else {
          j += 1;
        }
      }
    }
  }
  const open: [number, number][] = [];
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) if (!grid[c][r]) open.push([c, r]);
  let k = 0;
  for (const f of fillers) {
    for (let i = 0; i < f.n && k < open.length; i++) {
      const [c, r] = open[k++];
      grid[c][r] = f;
    }
  }
  return grid;
}

export interface PlacedBlock {
  /** the block's main rectangle, in cells */
  c: number;
  r: number;
  w: number;
  h: number;
}

/** Shapes for n cells, best first: rectangles nearest square, then a
 *  rectangle with a horizontal tail (part of one more row under it). Cells
 *  are [dc, dr] offsets from the shape's top-left cell. */
function shapesFor(n: number, cols: number, rows: number) {
  const out: { cells: [number, number][]; main: { w: number; h: number }; score: number }[] = [];
  for (let h = 1; h <= rows; h++) {
    if (n % h) continue;
    const w = n / h;
    if (w > cols) continue;
    const cells: [number, number][] = [];
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) cells.push([c, r]);
    out.push({ cells, main: { w, h }, score: Math.abs(Math.log(w / h)) });
  }
  for (let h = 1; h < rows; h++) {
    for (let w = 2; w <= cols; w++) {
      const tail = n - w * h;
      if (tail <= 0 || tail >= w) continue;
      const cells: [number, number][] = [];
      for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) cells.push([c, r]);
      for (let c = 0; c < tail; c++) cells.push([c, h]);
      out.push({ cells, main: { w, h }, score: 10 + Math.abs(Math.log(w / (h + 1))) });
    }
  }
  return out.sort((a, b) => a.score - b.score);
}

/**
 * One cell per unit, each user a rectangle where the counts allow it (else a
 * rectangle with a short horizontal tail), found by a bounded search that
 * fills the grid from the top-left; whole fillers (one node's idle GPUs) are
 * placed the same way after the users, so a node's cells stay together; the
 * other fillers (free, offline in bulk) take the cells left over. Falls back
 * to packColumns when the search runs out.
 */
export function packRects<T extends GridItem>(items: T[], cols: number, rows: number, budget = 60000):
  { grid: (T | null)[][]; blocks: Map<string, PlacedBlock> } | null {
  // users first, then whole fillers: the order the search tries them in
  const users = [
    ...items.filter((i) => !i.filler && i.n > 0),
    ...items.filter((i) => i.filler && i.whole && i.n > 0),
  ];
  const fillers = items.filter((i) => i.filler && !i.whole && i.n > 0);
  const holes = fillers.reduce((a, f) => a + f.n, 0);
  const owner: (T | null | undefined)[][] = Array.from({ length: cols }, () => Array<T | null | undefined>(rows).fill(undefined));
  const blocks = new Map<string, PlacedBlock>();
  const shapes = new Map(users.map((u) => [u.key, shapesFor(u.n, cols, rows)]));
  const used = new Set<string>();
  let steps = 0;
  const firstEmpty = (): [number, number] | null => {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (owner[c][r] === undefined) return [c, r];
    return null;
  };
  const dfs = (holesLeft: number): boolean => {
    if (++steps > budget) return false;
    const at = firstEmpty();
    if (!at) return used.size === users.length;
    const [c0, r0] = at;
    // pieces of one size have the same shapes: trying a second one here
    // only repeats the first one's search under another name
    const triedSizes = new Set<number>();
    for (const u of users) {
      if (used.has(u.key) || triedSizes.has(u.n)) continue;
      triedSizes.add(u.n);
      for (const s of shapes.get(u.key)!) {
        if (!s.cells.every(([dc, dr]) => c0 + dc < cols && r0 + dr < rows && owner[c0 + dc][r0 + dr] === undefined)) continue;
        for (const [dc, dr] of s.cells) owner[c0 + dc][r0 + dr] = u;
        used.add(u.key);
        blocks.set(u.key, { c: c0, r: r0, w: s.main.w, h: s.main.h });
        if (dfs(holesLeft)) return true;
        for (const [dc, dr] of s.cells) owner[c0 + dc][r0 + dr] = undefined;
        used.delete(u.key);
        blocks.delete(u.key);
        if (steps > budget) return false;
      }
    }
    // leave this cell to the fillers
    if (holesLeft > 0) {
      owner[c0][r0] = null;
      if (dfs(holesLeft - 1)) return true;
      owner[c0][r0] = undefined;
    }
    return false;
  };
  if (!dfs(holes)) {
    const grid = packColumns(items, cols, rows);
    if (!grid) return null;
    // blocks for the column layout: each owner's first full-height run
    const fb = new Map<string, PlacedBlock>();
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
      const it = grid[c][r];
      if (!it || fb.has(it.key)) continue;
      let h = 1;
      while (r + h < rows && grid[c][r + h]?.key === it.key) h += 1;
      let w = 1;
      while (c + w < cols && Array.from({ length: h }, (_, k) => grid[c + w][r + k]?.key === it.key).every(Boolean)) w += 1;
      fb.set(it.key, { c, r, w, h });
    }
    return { grid, blocks: fb };
  }
  // fillers into the cells left, in reading order
  const grid: (T | null)[][] = owner.map((col) => col.map((x) => x ?? null));
  const open: [number, number][] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (grid[c][r] === null) open.push([c, r]);
  let k = 0;
  for (const f of fillers) {
    const start = k;
    for (let i = 0; i < f.n && k < open.length; i++, k++) grid[open[k][0]][open[k][1]] = f;
    if (k > start) {
      const [c, r] = open[start];
      let w = 1;
      while (c + w < cols && grid[c + w][r]?.key === f.key) w += 1;
      blocks.set(f.key, { c, r, w, h: 1 });
    }
  }
  return { grid, blocks };
}


const touching = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;

/** The cells walked as a snake along rows (or columns): each line in turn,
 *  every other one reversed, `flip` choosing the first line's direction. */
function snake(cells: [number, number][], byCol: boolean, flip: boolean): number[] {
  const lines = new Map<number, number[]>();
  cells.forEach(([c, r], i) => {
    const k = byCol ? c : r;
    lines.set(k, [...(lines.get(k) ?? []), i]);
  });
  const along = (i: number) => (byCol ? cells[i][1] : cells[i][0]);
  return [...lines.keys()].sort((a, b) => a - b).flatMap((k, n) => {
    const line = lines.get(k)!.sort((a, b) => along(a) - along(b));
    return (n % 2 === 1) !== flip ? line.reverse() : line;
  });
}

/** A walk through the cells that steps to the neighbour with the fewest
 *  ways on (Warnsdorff), jumping to the next cell in reading order when it
 *  is stuck. */
function greedyWalk(cells: [number, number][]): number[] {
  const at = new Map(cells.map(([c, r], i) => [`${c},${r}`, i]));
  const seen = cells.map(() => false);
  const next = (i: number) => {
    const [c, r] = cells[i];
    return ([[c + 1, r], [c, r + 1], [c - 1, r], [c, r - 1]] as const)
      .map(([x, y]) => at.get(`${x},${y}`))
      .filter((j): j is number => j !== undefined && !seen[j]);
  };
  const reading = cells.map((_, i) => i).sort((a, b) => cells[a][1] - cells[b][1] || cells[a][0] - cells[b][0]);
  const order: number[] = [];
  let cur: number | undefined;
  while (order.length < cells.length) {
    cur ??= reading.find((i) => !seen[i])!;
    seen[cur] = true;
    order.push(cur);
    const ns = next(cur);
    cur = ns.length ? ns.reduce((best, j) => (next(j).length < next(best).length ? j : best)) : undefined;
  }
  return order;
}

/**
 * Which part (a node) each of one owner's cells belongs to, so the cells of
 * a part touch: the owner's cells are walked as a snake, by rows or by
 * columns, whichever keeps the most parts in a straight line, and cut into
 * runs, the biggest parts first. Per cell, in the order given: `part`, the
 * index into `parts` (cells past the parts' total get one index each, from
 * parts.length on), and `rank`, the cell's place along its part's run.
 */
export function cellParts(cells: [number, number][], parts: number[]): { part: number[]; rank: number[] } {
  const bySize = parts.map((n, i) => ({ n, i })).filter((p) => p.n > 0).sort((a, b) => b.n - a.n || a.i - b.i);
  const cutRanked = (order: number[]) => {
    const part = new Array<number>(cells.length).fill(0);
    const rank = new Array<number>(cells.length).fill(0);
    let k = 0;
    let extra = parts.length;
    let id = bySize[0]?.i ?? extra++;
    let left = bySize[0]?.n ?? 1;
    let r = 0;
    for (const i of order) {
      if (left === 0) {
        k += 1;
        id = bySize[k]?.i ?? extra++;
        left = bySize[k]?.n ?? 1;
        r = 0;
      }
      part[i] = id;
      rank[i] = r++;
      left -= 1;
    }
    return { part, rank };
  };
  const cut = (order: number[]) => cutRanked(order).part;
  const straight = (ids: number[]) => {
    const groups = new Map<number, [number, number][]>();
    ids.forEach((id, i) => groups.set(id, [...(groups.get(id) ?? []), cells[i]]));
    return [...groups.values()].filter((g) => g.every(([c]) => c === g[0][0]) || g.every(([, r]) => r === g[0][1])).length;
  };
  let best: { order: number[]; score: number } | null = null;
  for (const [byCol, flip] of [[false, false], [false, true], [true, false], [true, true]] as const) {
    const order = snake(cells, byCol, flip);
    if (!order.every((i, k) => k === 0 || touching(cells[order[k - 1]], cells[i]))) continue;
    const score = straight(cut(order));
    if (!best || score > best.score) best = { order, score };
  }
  return cutRanked(best?.order ?? greedyWalk(cells));
}
