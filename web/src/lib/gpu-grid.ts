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
