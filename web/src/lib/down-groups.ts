import type { DownNode } from "@/types/snapshot";

export type DownTone = "maint" | "fault" | "drain";

/** Nodes out of service for one cause: same pool, same Slurm states, same
 *  reason text. Seventeen rows of "Not responding" read as one incident. */
export interface DownGroup {
  key: string;
  pool: string;
  states: string[];
  /** the reason without Slurm's "[user@time]" stamp */
  reason: string;
  /** who set it ("slurm" for an automatic mark, else an admin) */
  by: string;
  /** earliest stamp in the group, cluster-local ISO; "" when none */
  since: string;
  nodes: string[];
  tone: DownTone;
}

const STAMP = /\s*\[([^@\]]+)@([0-9T:-]+)\]\s*$/;

/** gray: planned (a maintenance reason or MAINT state, or a pool wholly
 *  offline); red: the node failed; amber: drained for another reason. */
export function downTone(node: DownNode, poolInMaint: boolean): DownTone {
  const states = new Set(node.state.map((s) => s.toUpperCase()));
  if (poolInMaint || states.has("MAINT") || /^maint/i.test(node.reason || "")) return "maint";
  if (states.has("DOWN") || states.has("NOT_RESPONDING")) return "fault";
  return "drain";
}

export function groupDownNodes(nodes: DownNode[], maintPools: Set<string>): DownGroup[] {
  const groups = new Map<string, DownGroup>();
  for (const n of nodes) {
    const m = (n.reason || "").match(STAMP);
    const reason = (m ? n.reason.slice(0, m.index) : n.reason || "").trim();
    const states = [...n.state].sort();
    const key = `${n.pool}|${states.join(",")}|${reason}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, pool: n.pool, states: n.state, reason, by: m?.[1] ?? "", since: "", nodes: [], tone: downTone(n, maintPools.has(n.pool)) };
      groups.set(key, g);
    }
    g.nodes.push(n.name);
    const at = m?.[2] ?? "";
    if (at && (!g.since || at < g.since)) g.since = at;
  }
  const rank: Record<DownTone, number> = { fault: 0, drain: 1, maint: 2 };
  return [...groups.values()].sort((a, b) => rank[a.tone] - rank[b.tone] || b.nodes.length - a.nodes.length || a.key.localeCompare(b.key));
}

/** "spcc-cld-g01".."g16" -> "spcc-cld-g[01-16]"; names that share no
 *  numbered stem stay as they are. */
export function compressHostlist(names: string[]): string {
  const stems = new Map<string, string[]>();
  const loose: string[] = [];
  for (const n of names) {
    const m = n.match(/^(.*?)(\d+)$/);
    if (!m) loose.push(n);
    else stems.set(m[1], [...(stems.get(m[1]) ?? []), m[2]]);
  }
  const out: string[] = [];
  for (const [stem, nums] of stems) {
    if (nums.length === 1) {
      out.push(stem + nums[0]);
      continue;
    }
    nums.sort((a, b) => Number(a) - Number(b));
    const ranges: string[] = [];
    let start = nums[0];
    let prev = nums[0];
    for (const cur of [...nums.slice(1), ""]) {
      if (cur && Number(cur) === Number(prev) + 1 && cur.length === prev.length) {
        prev = cur;
        continue;
      }
      ranges.push(start === prev ? start : `${start}-${prev}`);
      start = cur;
      prev = cur;
    }
    out.push(`${stem}[${ranges.join(",")}]`);
  }
  return [...out, ...loose].join(",");
}
