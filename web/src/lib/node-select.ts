/**
 * Which nodes Slurm gives a job that starts now, and how many CPUs on each —
 * Slurm 25.05's own selection, ported step by step so the queue model claims
 * what Slurm would take instead of a guess.
 *
 * Hakusan runs select/cons_tres with SelectTypeParameters=CR_CORE_MEMORY and
 * TopologyPlugin=topology/tree, TopologyParam unset, so every job goes through
 * _eval_nodes_topo() (src/plugins/topology/tree/eval_nodes_tree.c, tag
 * slurm-25-05-5-1). In short:
 *
 *  1. Per node, the CPUs this job could use (cons_tres job_test.c
 *     _can_job_run_on_node): its free cores, cut by --ntasks-per-node, by
 *     memory (--mem-per-cpu: cores x MB must fit; --mem: per node, pass/fail),
 *     rounded down to whole tasks (--cpus-per-task). A GPU job needs its GPUs
 *     there; Slurm then favours nodes with more free GPUs (sched_weight).
 *  2. The top switch: the highest-level switch that holds enough nodes and
 *     CPUs. Only its nodes are used.
 *  3. Leaf switches one at a time: one that fits the whole job, the tightest
 *     (fewest usable nodes) first; else the one with the most nodes, then the
 *     nearest to those already used.
 *  4. Inside a leaf switch: nodes in Slurm's node order (slurm.conf, which is
 *     `scontrol show nodes` order), each giving all its usable CPUs except one
 *     per node still to come (eval_nodes_cpus_to_use), until the job's node
 *     count and CPUs are met.
 *  5. When that fails — typically a fixed -N reached before the CPUs —
 *     Slurm drops the nodes with the fewest usable CPUs, 1, then 2, ..., and
 *     tries again (common_topo_choose_nodes, topology/common/common_topo.c).
 *     Without --ntasks-per-node a job uses at most as many nodes as tasks.
 *
 * Checked against `sbatch --test-only` on the live cluster: see
 * node-select.fixtures.ts.
 */

export interface FreeNode {
  name: string;
  /** free cores, memory (MB) and GPUs now */
  cores: number;
  memMb: number;
  gpus: number;
  gpuType: string;
  /** booked for a queued job from this time on (ms): backfill reserves the
   *  whole node then, so only a job that ends by this time may use it */
  until?: number;
}

export interface NodeRequest {
  /** job's minimum node count (squeue NumNodes while pending) */
  minNodes: number;
  /** task count (squeue NumTasks); 0 = unknown */
  tasks: number;
  /** -N's upper bound; 0 = not given */
  maxNodes: number;
  /** total CPUs (squeue %C) */
  cpus: number;
  cpusPerTask: number;
  /** --ntasks-per-node; 0 = not given */
  tasksPerNode: number;
  /** fewest CPUs a node must give (squeue MinCpus) */
  minCpusNode: number;
  /** --mem-per-cpu, else --mem per node (MB); 0 = unknown */
  memPerCpuMb: number;
  memPerNodeMb: number;
  gpusPerNode: number;
  /** a GPU type named in --gres ("" = any) */
  gpuType: string;
  /** --nodelist hosts (all used) and --exclude hosts */
  required: string[];
  excluded: string[];
  /** when the job ends at the latest if it starts now (ms); absent = no limit */
  endsAt?: number;
}

export interface Switch {
  name: string;
  level: number;
  /** node names under it */
  nodes: Set<string>;
  /** index of its parent switch, -1 at the top */
  parent: number;
}

export interface Take {
  name: string;
  cpus: number;
  memMb: number;
  gpus: number;
}

/** Step 1 (_can_job_run_on_node): the CPUs this job can use on a node, 0 = none. */
export function usableCpus(node: FreeNode, req: NodeRequest): number {
  if (req.excluded.includes(node.name)) return 0;
  if (node.until !== undefined && !(req.endsAt !== undefined && req.endsAt <= node.until)) return 0;
  if (req.gpusPerNode > 0 && (node.gpus < req.gpusPerNode || (req.gpuType && req.gpuType !== node.gpuType))) return 0;
  const cpt = Math.max(1, req.cpusPerTask);
  let cpus = node.cores;
  if (req.tasksPerNode > 0) cpus = Math.min(cpus, req.tasksPerNode * cpt);
  if (req.memPerCpuMb > 0) {
    cpus = Math.min(cpus, Math.floor(node.memMb / req.memPerCpuMb));
  } else if (req.memPerNodeMb > 0 && req.memPerNodeMb > node.memMb) {
    return 0;
  }
  cpus -= cpus % cpt;
  if (cpus < Math.max(1, req.minCpusNode, req.tasksPerNode * cpt)) return 0;
  return cpus;
}

/** The switch table from `scontrol show topology` rows; nodes and child
 *  switches arrive as hostlists. Its order is Slurm's switch index. */
export function switchTable(rows: { name: string; level: number; nodes: string; switches: string }[],
                            expand: (hostlist: string) => string[]): Switch[] {
  const table = rows.map((r) => ({ name: r.name, level: r.level, nodes: new Set(expand(r.nodes)), parent: -1 }));
  rows.forEach((r, i) => {
    for (const child of expand(r.switches)) {
      const c = table.findIndex((s) => s.name === child);
      if (c >= 0) table[c].parent = i;
    }
  });
  return table;
}

/** Hops between two switches through the tree (switch_record.c), Infinity
 *  when they share no ancestor. */
function hops(table: Switch[], a: number, b: number): number {
  const up = (i: number) => {
    const path = [i];
    while (table[path[path.length - 1]].parent >= 0) path.push(table[path[path.length - 1]].parent);
    return path;
  };
  const pa = up(a);
  const pb = up(b);
  for (let i = 0; i < pa.length; i++) {
    const j = pb.indexOf(pa[i]);
    if (j >= 0) return i + j;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * The nodes a job starts on, in the order Slurm fills them, or null when it
 * cannot start on these nodes now. `nodes` must be in Slurm's node order; an
 * empty `table` means no topology (one switch holds every node).
 * (common_topo_choose_nodes)
 */
export function selectNodes(nodes: FreeNode[], req: NodeRequest, table: Switch[]): Take[] | null {
  const cpusOf = new Map(nodes.map((n) => [n.name, usableCpus(n, req)]));
  if (req.required.some((n) => !cpusOf.get(n))) return null;
  let candidates = nodes.filter((n) => (cpusOf.get(n.name) ?? 0) > 0);
  let maxNodes = req.maxNodes > 0 ? req.maxNodes : Number.POSITIVE_INFINITY;
  if (req.tasks > 0 && !req.tasksPerNode && maxNodes > req.tasks) maxNodes = Math.max(req.tasks, req.minNodes);
  const minNodes = Math.max(1, req.minNodes);
  const attempt = () => (candidates.length < minNodes ? null : evalTopo(candidates, req, table, cpusOf, maxNodes));
  const first = attempt();
  if (first || candidates.length <= minNodes) return first;
  // drop the nodes with the fewest usable CPUs (+ GPUs), a step at a time
  const resOf = (n: FreeNode) => (cpusOf.get(n.name) ?? 0) + (req.gpusPerNode > 0 ? n.gpus : 0);
  const most = Math.max(0, ...candidates.map(resOf));
  for (let count = 1; count < most; count++) {
    let changed = false;
    let left = candidates.length;
    candidates = candidates.filter((n) => {
      if (left <= minNodes || req.required.includes(n.name) || resOf(n) > count) return true;
      left -= 1;
      changed = true;
      return false;
    });
    if (!changed) continue;
    count -= 1;   // a pass may cut usable CPUs: look at the same count again
    const placed = attempt();
    if (placed) return placed;
    if (candidates.length <= minNodes) break;
  }
  return null;
}

/** One pass of _eval_nodes_topo over the candidate nodes. Cuts a node's
 *  usable CPUs when it gives fewer (Slurm keeps that cut for a retry). */
function evalTopo(nodes: FreeNode[], req: NodeRequest, table: Switch[], cpusOf: Map<string, number>,
                  maxNodesIn: number): Take[] | null {
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const switches = table.length ? table : [{ name: "", level: 0, nodes: new Set(nodes.map((n) => n.name)), parent: -1 }];
  const order = nodes.map((n) => n.name);
  const minNodes = Math.max(1, req.minNodes);
  // get_node_cnts(): aim for -N's maximum when one was given
  const reqNodes = req.maxNodes > 0 ? Math.max(minNodes, req.maxNodes) : minNodes;
  let maxNodes = maxNodesIn;
  let remNodes = Math.max(minNodes, reqNodes);
  let minRemNodes = minNodes;
  let remCpus = req.cpus;
  let remMaxCpus = req.cpus;
  const enoughNodes = (avail: number, rem: number) => avail >= (reqNodes > minNodes ? rem + minNodes - reqNodes : rem);
  const taken: Take[] = [];
  const used = new Set<string>();

  // eval_nodes_cpus_to_use(): all usable CPUs but one per node still to come
  const take = (name: string) => {
    let cpus = cpusOf.get(name) ?? 0;
    const room = remMaxCpus - Math.max(minRemNodes - 1, 0);
    if (cpus > room) {
      cpus = Math.max(room, req.minCpusNode, 1);
      cpusOf.set(name, cpus);
    }
    const node = byName.get(name)!;
    taken.push({ name, cpus, gpus: req.gpusPerNode,
      memMb: req.memPerCpuMb > 0 ? cpus * req.memPerCpuMb : Math.min(req.memPerNodeMb, node.memMb) });
    used.add(name);
    remNodes -= 1;
    minRemNodes -= 1;
    maxNodes -= 1;
    remCpus -= cpus;
    remMaxCpus -= cpus;
  };
  const done = () => remNodes <= 0 && remCpus <= 0;

  // --nodelist hosts come first
  for (const name of req.required) {
    if (!byName.has(name)) return null;
    take(name);
  }
  if (req.required.length && done()) return taken;

  // usable nodes, grouped by weight: all equal for CPUs; a GPU job prefers
  // nodes with more free GPUs (job_test.c: sched_weight | 0xff - near_gpu_cnt)
  const usable = order.filter((n) => !used.has(n) && (cpusOf.get(n) ?? 0) > 0);
  const weight = (n: string) => (req.gpusPerNode > 0 ? 0xff - byName.get(n)!.gpus : 0);

  // step 2: the top switch — highest level with enough nodes and CPUs
  const inSwitch = (s: Switch) => usable.filter((n) => s.nodes.has(n));
  const switchCpus = switches.map((s) => inSwitch(s).reduce((sum, n) => sum + (cpusOf.get(n) ?? 0), 0));
  let top = -1;
  switches.forEach((s, i) => {
    if (!enoughNodes(inSwitch(s).length, remNodes) || remCpus > switchCpus[i]) return;
    if (top === -1 || s.level >= switches[top].level) top = i;
  });
  if (top === -1) return null;
  const under = new Set(inSwitch(switches[top]));

  // weight groups, lightest first, until they hold the request; every group
  // before the last is taken whole (Slurm's req2 nodes)
  const groups = [...new Set(usable.filter((n) => under.has(n)).map(weight))].sort((a, b) => a - b);
  const best: string[] = [];
  let bestCpus = 0;
  let whole: string[] = [];
  for (const w of groups) {
    whole = [...best];
    for (const n of usable) {
      if (!under.has(n) || weight(n) !== w) continue;
      best.push(n);
      bestCpus += cpusOf.get(n) ?? 0;
    }
    if (best.length >= remNodes && bestCpus >= remCpus) break;
  }
  if (bestCpus < remCpus || !enoughNodes(best.length, remNodes)) return null;
  const bestSet = new Set(best);
  for (const n of order) {
    if (!whole.includes(n) || maxNodes <= 0) continue;
    take(n);
  }
  if (whole.length && done()) return taken;

  // step 3/4: leaf switches, then their nodes in node order
  const leaves = switches.map((s, i) => ({ s, i })).filter(({ s }) => s.level === 0);
  const leafCount = new Map(leaves.map(({ s, i }) => [i, order.filter((n) => s.nodes.has(n) && bestSet.has(n)).length]));
  const required = new Set(leaves.filter(({ s }) => [...used].some((n) => s.nodes.has(n))).map(({ i }) => i));
  const fill = (s: Switch) => {
    for (const n of order) {
      if (!s.nodes.has(n) || !bestSet.has(n) || used.has(n) || maxNodes <= 0) continue;
      take(n);
      if (done()) return true;
    }
    return false;
  };
  for (const i of required) {
    if (fill(switches[i])) return taken;
    leafCount.set(i, 0);
  }
  const dist = switches.map((_, k) => [...required].reduce((sum, r) => sum + hops(switches, r, k), 0));
  const fits = (i: number) => (leafCount.get(i) ?? 0) >= remNodes && switchCpus[i] >= remCpus;
  // _topo_compare_switches(): 1 if a is the better fit
  const better = (a: number, b: number) => {
    let x = a;
    let y = b;
    for (;;) {
      const xf = (leafCount.get(x) ?? countUnder(x)) >= remNodes && switchCpus[x] >= remCpus;
      const yf = (leafCount.get(y) ?? countUnder(y)) >= remNodes && switchCpus[y] >= remCpus;
      if (xf && yf) return Math.sign(count(y) - count(x));
      if (xf) return 1;
      if (yf) return -1;
      const px = switches[x].parent;
      const py = switches[y].parent;
      if ((px !== -1 || py !== -1) && px !== py && px !== -1 && py !== -1) {
        x = px;
        y = py;
        continue;
      }
      break;
    }
    return Math.sign(count(x) - count(y)) || Math.sign(switches[y].level - switches[x].level);
  };
  const countUnder = (i: number) => order.filter((n) => switches[i].nodes.has(n) && bestSet.has(n) && !used.has(n)).length;
  const count = (i: number) => leafCount.get(i) ?? countUnder(i);
  for (;;) {
    let bestLeaf = -1;
    for (const { i } of leaves) {
      if (required.has(i) || !(leafCount.get(i) ?? 0) || dist[i] === Number.POSITIVE_INFINITY) continue;
      if (bestLeaf === -1) {
        bestLeaf = i;
        continue;
      }
      const cmp = better(i, bestLeaf);
      if ((dist[i] < dist[bestLeaf] && fits(i)) || (dist[i] === dist[bestLeaf] && cmp > 0)) bestLeaf = i;
    }
    if (bestLeaf === -1) break;
    switches.forEach((_, k) => { dist[k] += hops(switches, bestLeaf, k); });
    if (fill(switches[bestLeaf])) return taken;
    if (maxNodes <= 0) return null;
    leafCount.set(bestLeaf, 0);
  }
  return minRemNodes <= 0 && remCpus <= 0 ? taken : null;
}
