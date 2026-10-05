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
 * fills the grid from the top-left; fillers (free, offline) take the cells
 * the users leave. Falls back to packColumns when the search runs out.
 */
export function packRects<T extends GridItem>(items: T[], cols: number, rows: number, budget = 60000):
  { grid: (T | null)[][]; blocks: Map<string, PlacedBlock> } | null {
  const users = items.filter((i) => !i.filler && i.n > 0);
  const fillers = items.filter((i) => i.filler && i.n > 0);
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
    for (const u of users) {
      if (used.has(u.key)) continue;
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
