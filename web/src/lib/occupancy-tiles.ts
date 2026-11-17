// Tiles for the occupancy maps that the pool card and the overview share.
import type { NodePart, OccupancyTile } from "@/components/common/occupancy-map";
import type { TFn } from "@/i18n";
import { idleGpuBucket, parseGpuCount, type NodeGpus } from "@/lib/derive";
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
    parts: [{ n: r.n }],
  }));
  return { tiles, ...sums };
}

/** A user tile's GPUs node by node, when they add up to the tile (else
 *  none: the grid then draws every cell on its own). A job's GPUs count as
 *  several on a node when it holds two or more there; each cell's hover
 *  names the node and the jobs on it. */
export function userNodeParts(nodes: NodeGpus[] | undefined, value: number, t: TFn): NodePart[] | undefined {
  if (!nodes || nodes.reduce((a, p) => a + p.n, 0) !== value) return undefined;
  return nodes.map((p) => ({
    n: p.n,
    multi: p.jobs.filter((j) => j.n >= 2).map((j) => ({ id: j.id, n: j.n })),
    lines: p.node ? [p.node, ...p.jobs.map((j) => t("users.partJob", { id: j.id, n: j.n }))] : undefined,
  }));
}
