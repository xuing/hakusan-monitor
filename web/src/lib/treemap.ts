/** A rectangle the occupancy map draws, in the box's own pixels. */
export interface TreemapRect<T> {
  item: T;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Squarified treemap (Bruls, Huizing & van Wijk): every item gets an area
 * proportional to its value, laid out in rows that keep the rectangles as
 * close to square as the values allow. Items keep their order — sort them
 * largest first for the best shapes.
 */
export function squarify<T>(items: T[], value: (item: T) => number, width: number, height: number): TreemapRect<T>[] {
  const live = items.filter((i) => value(i) > 0);
  const total = live.reduce((sum, i) => sum + value(i), 0);
  if (total <= 0 || width <= 0 || height <= 0) return [];
  const scale = (width * height) / total;
  const areas = live.map((item) => ({ item, a: value(item) * scale }));
  const out: TreemapRect<T>[] = [];
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;
  // the worst aspect ratio a row would have laid along a side of this length
  const worst = (row: { a: number }[], side: number) => {
    const sum = row.reduce((s, r) => s + r.a, 0);
    const max = Math.max(...row.map((r) => r.a));
    const min = Math.min(...row.map((r) => r.a));
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h);
    const row = [areas[i]];
    i += 1;
    while (i < areas.length && worst([...row, areas[i]], side) <= worst(row, side)) {
      row.push(areas[i]);
      i += 1;
    }
    const sum = row.reduce((s, r) => s + r.a, 0);
    if (w >= h) {
      // a column along the left edge
      const cw = sum / h;
      let yy = y;
      for (const r of row) {
        const rh = r.a / cw;
        out.push({ item: r.item, x, y: yy, w: cw, h: rh });
        yy += rh;
      }
      x += cw;
      w -= cw;
    } else {
      // a row along the top edge
      const rh = sum / w;
      let xx = x;
      for (const r of row) {
        const rw = r.a / rh;
        out.push({ item: r.item, x: xx, y, w: rw, h: rh });
        xx += rw;
      }
      y += rh;
      h -= rh;
    }
  }
  return out;
}
