// Tiles for the occupancy maps that the pool card and the overview share.
import type { OccupancyTile } from "@/components/common/occupancy-map";
import type { TFn } from "@/i18n";
import { idleGpuBucket, parseGpuCount } from "@/lib/derive";
import type { Pool, Snapshot } from "@/types/snapshot";

/** The pool's idle GPUs as one tile per node and kind (free, reserved,
 *  offline), with the totals they add up to; the biggest first. */
export function idleGpuTiles(pool: Pool, snap: Snapshot, unit: (n: number) => string, t: TFn) {
  const type = pool.gpu?.type ?? "";
  const sums = { free: 0, reserved: 0, down: 0 };
  const rows: { name: string; kind: "free" | "reserved" | "down"; n: number }[] = [];
  for (const node of snap.nodes) {
    if (node.pool !== pool.id) continue;
    const n = Math.max(0, parseGpuCount(node.gres, type) - parseGpuCount(node.gres_used, type));
    const kind = idleGpuBucket(node);
    if (n <= 0 || kind === "short") continue;
    sums[kind] += n;
    rows.push({ name: node.name, kind, n });
  }
  const order = { free: 0, reserved: 1, down: 2 };
  rows.sort((a, b) => order[a.kind] - order[b.kind] || b.n - a.n || a.name.localeCompare(b.name));
  const tiles: OccupancyTile[] = rows.map((r) => ({
    key: `~${r.kind}:${r.name}`,
    value: r.n,
    kind: r.kind === "down" ? "off" : r.kind,
    amount: unit(r.n),
    sub: t(r.kind === "free" ? "users.free" : r.kind === "reserved" ? "users.reserved" : "users.offline"),
    details: [r.name, ...(r.kind === "reserved" ? [t("users.reservedDetail")] : [])],
    parts: [r.n],
  }));
  return { tiles, ...sums };
}

/** The tile's GPUs per node, when they add up to the tile; else none (the
 *  grid then draws every cell on its own). */
export function nodeParts(parts: number[] | undefined, value: number): number[] | undefined {
  return parts && parts.reduce((a, b) => a + b, 0) === value ? parts : undefined;
}
