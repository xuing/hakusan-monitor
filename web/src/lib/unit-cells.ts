/** How many cells a pool's bar gets: one per node, so a cell is one node's
 *  worth of the pool (lcpcc 124 cells of 256 cores, VM-CPU 44 of 32, the
 *  large-memory node one cell). Without a node count, by pool size. Bars
 *  show shares, not node states: a cell is a node's worth, not a node. */
export function barCells(total: number, nodes = 0): number {
  if (nodes > 0) return nodes;
  return total >= 10_000 ? 96 : total >= 1_000 ? 48 : 24;
}

/** Cells per segment for a bar of at most maxCells. Every segment that is not
 *  zero keeps at least one cell, taken from the largest: 107 free cores of
 *  31,744 are a third of a cell, and rounding them away drew a pool with free
 *  cores as completely full. */
export function scaleCells(values: number[], total: number, maxCells = 48): number[] {
  const cells = Math.max(1, Math.min(maxCells, Math.round(total)));
  if (total <= maxCells) return values.map((v) => Math.max(0, Math.round(v)));
  const raw = values.map((v) => (Math.max(0, v) / total) * cells);
  const out = raw.map(Math.floor);
  let remaining = cells - out.reduce((sum, n) => sum + n, 0);
  raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac)
    .forEach(({ i }) => {
      if (remaining > 0) {
        out[i] += 1;
        remaining -= 1;
      }
    });
  values.forEach((v, i) => {
    if (v <= 0 || out[i] > 0) return;
    const donor = out.indexOf(Math.max(...out));
    if (out[donor] > 1) {
      out[donor] -= 1;
      out[i] = 1;
    }
  });
  return out;
}
