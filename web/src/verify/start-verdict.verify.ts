/**
 * Start-verdict verification: generated-input checks of the real code that
 * tells a user whether their job starts now. See
 * .claude/skills/verify-start-verdict/SKILL.md for what each property
 * promises, what it covers, and how to read a failure.
 *
 *   cd web && npm run verify                      # all properties
 *   VERIFY_RUNS=3000 npm run verify               # deeper
 *   VERIFY_SEED=123 npm run verify -- -t P2       # replay one property
 */
import fc from "fast-check";
import { afterAll, beforeAll, describe, it, vi } from "vitest";
import { cpuStartLimits, cpuStartMemMb, liveCpuStart } from "@/lib/cpu-probes";
import { expandHostlist, nodeIsBackfillCandidate, nodeIsSchedulable, parseGpuCount } from "@/lib/derive";
import { gpuStartCount, gpuStatus } from "@/lib/gpu-partition";
import { selectNodes, switchTable, type FreeNode, type NodeRequest } from "@/lib/node-select";
import { partitionsOf, queueModel } from "@/lib/queue";
import { partitionPolicy } from "@/lib/slurm";
import {
  buildSnapshot, CPU_PARTS, GEN, GPU_PARTS, isGpuNode, isSchedulable, partOf, perNode, qosOfPart, scenarioArb, tell,
  type JobSpec, type Scenario,
} from "./start-verdict.scenario";

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const RUNS = Number(env.VERIFY_RUNS || 400);
const SEED = env.VERIFY_SEED ? Number(env.VERIFY_SEED) : undefined;
const params = { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) };
const NOW_MS = GEN * 1000;

/** A property violation; `parts` names the partitions it is about. */
class Broken extends Error {
  parts: string[];
  constructor(msg: string, parts: string[] = []) {
    super(msg);
    this.parts = parts;
  }
}
const fail = (msg: string, sc?: Scenario, parts: string[] = []): never => {
  throw new Broken(msg + (sc ? "\n" + tell(sc) : ""), parts);
};

/** The property as a plain check: any failing case is a finding, with
 *  nothing excused (the findings so far, all fixed: SKILL.md "Findings"). */
const holds = (check: (sc: Scenario) => void) => (sc: Scenario) => { check(sc); };

// gpuStartCount() judges against Date.now(): pin the clock to the snapshot.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW_MS));
});
afterAll(() => vi.useRealTimers());

// ---- P1: selectNodes only returns placements that fit ----------------------

const NAMES = ["n1", "n2", "n3", "n4", "n5"];

const freeNodesArb = fc.integer({ min: 1, max: 5 }).chain((k) => fc.tuple(...NAMES.slice(0, k).map((name) =>
  fc.record({
    name: fc.constant(name),
    cores: fc.integer({ min: 0, max: 16 }),
    memMb: fc.constantFrom(0, 1000, 4000, 16000, 64000),
    gpus: fc.integer({ min: 0, max: 4 }),
    gpuType: fc.constantFrom("tA", "tB"),
    until: fc.option(fc.integer({ min: 1, max: 600 }).map((m) => NOW_MS + m * 60_000), { nil: undefined }),
  }) as fc.Arbitrary<FreeNode>)));

const requestArb = (names: string[]): fc.Arbitrary<NodeRequest> => fc.record({
  minNodes: fc.integer({ min: 1, max: 3 }),
  maxNodesRaw: fc.constantFrom(0, 0, 1, 2, 4),
  nodeLimit: fc.constantFrom(0, 0, 1, 2, 4),
  cpt: fc.constantFrom(1, 1, 2, 4),
  tasks: fc.constantFrom(0, 0, 1, 2, 3, 6),
  tasksPerNode: fc.constantFrom(0, 0, 0, 1, 2),
  rawCpus: fc.integer({ min: 1, max: 32 }),
  minCpusFromTpn: fc.boolean(),
  memPerCpu: fc.constantFrom(0, 0, 500, 4000),
  memPerNode: fc.constantFrom(0, 2000, 16000, 64000),
  gpusPerNode: fc.constantFrom(0, 0, 1, 2),
  gpuType: fc.constantFrom("", "tA", "tB"),
  required: fc.subarray(names, { maxLength: Math.min(2, names.length) }),
  excluded: fc.subarray(names, { maxLength: Math.min(2, names.length) }),
  endsInMin: fc.option(fc.integer({ min: 1, max: 900 }), { nil: undefined }),
}).map((r) => {
  // Slurm's own normalisation of an accepted job (what squeue reports):
  // -N covers the --nodelist hosts and fits under -N's maximum, the CPU
  // total covers tasks x cpus-per-task, and MinCPUsNode covers a node's tasks.
  const minNodes = Math.max(r.minNodes, r.required.length);
  const maxNodes = r.maxNodesRaw ? Math.max(r.maxNodesRaw, minNodes) : 0;
  const tasks = r.tasksPerNode ? r.tasksPerNode * minNodes : r.tasks;
  return {
    minNodes, maxNodes, nodeLimit: r.nodeLimit, tasks,
    cpus: Math.max(minNodes, tasks ? tasks * r.cpt : r.rawCpus),
    cpusPerTask: r.cpt, tasksPerNode: r.tasksPerNode,
    minCpusNode: r.minCpusFromTpn && r.tasksPerNode ? r.tasksPerNode * r.cpt : r.cpt,
    memPerCpuMb: r.memPerCpu, memPerNodeMb: r.memPerCpu ? 0 : r.memPerNode,
    gpusPerNode: r.gpusPerNode, gpuType: r.gpusPerNode ? r.gpuType : "",
    required: r.required, excluded: r.excluded.filter((n) => !r.required.includes(n)),
    endsAt: r.endsInMin === undefined ? undefined : NOW_MS + r.endsInMin * 60_000,
  };
});

const topoArb = fc.oneof(fc.constant([] as number[]), fc.array(fc.constantFrom(0, 1), { minLength: 5, maxLength: 5 }));

function checkPlacement(nodes: FreeNode[], req: NodeRequest, leaves: number[]) {
  const table = leaves.length ? switchTable([
    { name: "s0", level: 0, nodes: nodes.filter((_, i) => leaves[i] === 0).map((n) => n.name).join(","), switches: "" },
    { name: "s1", level: 0, nodes: nodes.filter((_, i) => leaves[i] === 1).map((n) => n.name).join(","), switches: "" },
    { name: "top", level: 1, nodes: nodes.map((n) => n.name).join(","), switches: "s0,s1" },
  ], expandHostlist) : [];
  const placed = selectNodes(nodes.map((n) => ({ ...n })), req, table);
  if (!placed) return;
  const where = "selectNodes placed " + JSON.stringify(placed) + " for " + JSON.stringify(req) + " on " + JSON.stringify(nodes) + ": ";
  const names = placed.map((t) => t.name);
  if (new Set(names).size !== names.length) fail(where + "a node is used twice");
  const cap = (req.tasks > 0 && !req.tasksPerNode) ? Math.max(req.tasks, req.minNodes) : Infinity;
  const most = Math.min(req.maxNodes > 0 ? req.maxNodes : Infinity, req.nodeLimit > 0 ? req.nodeLimit : Infinity, cap);
  if (names.length < Math.max(1, req.minNodes)) fail(where + "fewer nodes than -N " + req.minNodes);
  if (names.length > most) fail(where + "more nodes than the job may span (" + most + ")");
  for (const r of req.required) if (!names.includes(r)) fail(where + "--nodelist host " + r + " is missing");
  const total = placed.reduce((s, t) => s + t.cpus, 0);
  if (total < req.cpus) fail(where + "only " + total + " of " + req.cpus + " CPUs");
  for (const t of placed) {
    const n = nodes.find((x) => x.name === t.name);
    if (!n) fail(where + t.name + " is not a candidate node");
    if (req.excluded.includes(t.name)) fail(where + t.name + " is --exclude'd");
    if (t.cpus < 1 || t.cpus > n!.cores) fail(where + t.name + " gives " + t.cpus + " CPUs, has " + n!.cores + " free");
    if (t.cpus < req.minCpusNode) fail(where + t.name + " gives " + t.cpus + " CPUs, below MinCPUsNode " + req.minCpusNode);
    if (t.gpus > n!.gpus) fail(where + t.name + " gives " + t.gpus + " GPUs, has " + n!.gpus + " free");
    if (req.gpusPerNode > 0 && req.gpuType && n!.gpuType !== req.gpuType) fail(where + t.name + " has " + n!.gpuType + ", job asked " + req.gpuType);
    if (t.memMb > n!.memMb) fail(where + t.name + " gives " + t.memMb + " MB, has " + n!.memMb + " free");
    if (!req.memPerCpuMb && req.memPerNodeMb > n!.memMb) fail(where + t.name + " has " + n!.memMb + " MB, job asks --mem " + req.memPerNodeMb);
    if (n!.until !== undefined && !(req.endsAt !== undefined && req.endsAt <= n!.until)) {
      fail(where + t.name + " is booked from " + n!.until + " and the job ends " + (req.endsAt ?? "never"));
    }
  }
}

// ---- helpers over a generated snapshot ---------------------------------------

const qosName = (sc: Scenario, p: string) => partOf(sc, p).qos;

/** May a placed waiter hold a claim on this node? --exclude rules it out.
 *  --nodelist hosts are all used, and Slurm adds other hosts only "as needed
 *  to satisfy resource requirements" (sbatch --nodelist): when the job needs
 *  more nodes than it lists, when the listed hosts' free room cannot hold it,
 *  or (conservatively) when another placed waiter may also take room there.
 *  (Narrower than this, queue.ts mayUseNode only allows the first case.) */
function mayUse(sc: Scenario, owners: JobSpec[], j: JobSpec, node: string) {
  if (j.exc.includes(node)) return false;
  if (j.req.length === 0 || j.req.includes(node) || j.nodes > j.req.length) return true;
  const listed = sc.nodes.filter((n) => j.req.includes(n.name));
  const share = perNode(j);
  const holds = listed.reduce((s, n) => s + n.cores - n.coresUsed, 0) >= j.cpus
    && listed.every((n) => (!isGpuNode(n) || n.gpus - n.gpusUsed >= (share.gpus || 1)) && n.memMb - n.memUsedMb >= share.memMb);
  const shared = owners.some((o) => o.id !== j.id && !o.exc.some((h) => j.req.includes(h))
    && listed.some((n) => n.parts.some((p) => o.parts.includes(p))));
  return !holds || shared;
}

/** P2: the queue play's claims fit what each node has free, and each node's
 *  claim is covered by the waiters placed in a partition of that node that
 *  may use it. */
function checkClaims(sc: Scenario) {
  const snap = buildSnapshot(sc);
  const q = queueModel(snap);
  const placed = q.waiters.filter((w) => w.placed);
  for (const w of placed) {
    if (!partitionsOf(w.job).includes(w.placed!)) fail("job " + w.job.job_id + " placed in " + w.placed + ", which it did not ask for", sc);
    if (!w.open.includes(w.placed!)) fail("job " + w.job.job_id + " placed in " + w.placed + ", not one of its open partitions " + w.open.join(","), sc);
  }
  for (const [name, c] of q.claims) {
    const n = snap.nodes.find((x) => x.name === name);
    if (!n) fail("claim on unknown node " + name, sc);
    if (!nodeIsSchedulable(n!) && !nodeIsBackfillCandidate(n!)) fail("claim on " + name + ", which no job can start on (" + n!.state.join("+") + ")", sc);
    const type = snap.pools.find((p) => p.id === n!.pool)?.gpu?.type ?? "";
    const free = {
      gpus: Math.max(0, parseGpuCount(n!.gres, type) - parseGpuCount(n!.gres_used, type)),
      cores: Math.max(0, n!.cpus - n!.alloc_cpus),
      memMb: Math.max(0, n!.real_memory - n!.alloc_memory),
    };
    if (c.gpus > free.gpus || c.cores > free.cores || c.memMb > free.memMb) {
      fail("the queue claims " + JSON.stringify(c) + " on " + name + " but only " + JSON.stringify(free) + " is free", sc);
    }
    // the owners: placed waiters whose partition holds this node and who may use it
    const placedJobs = placed.map((w) => sc.jobs.find((j) => j.id === w.job.job_id)!);
    const owners = placedJobs
      .filter((j) => n!.partitions.includes(placed.find((w) => w.job.job_id === j.id)!.placed!) && mayUse(sc, placedJobs, j, name));
    if (!owners.length) fail("claim " + JSON.stringify(c) + " on " + name + ", but no placed waiter may run there", sc);
    const most = owners.reduce((s, j) => {
      const share = perNode(j);
      return { gpus: s.gpus + (isGpuNode(sc.nodes.find((x) => x.name === name)!) ? share.gpus || 1 : 0),
        cores: s.cores + Math.max(j.cpus, j.nodes), memMb: s.memMb + share.memMb };
    }, { gpus: 0, cores: 0, memMb: 0 });
    if (c.gpus > most.gpus || c.cores > most.cores || c.memMb > most.memMb) {
      fail("the queue claims " + JSON.stringify(c) + " on " + name + ", more than its possible owners (jobs "
        + owners.map((j) => j.id).join(",") + ") take there at most: " + JSON.stringify(most), sc);
    }
  }
}

/** P3: the queue play starts no more jobs than GrpJobs / MaxJobsPerUser allow. */
function checkCaps(sc: Scenario) {
  const snap = buildSnapshot(sc);
  const q = queueModel(snap);
  const running = new Map<string, number>();
  const userRunning = new Map<string, number>();
  for (const j of sc.jobs.filter((j) => j.running)) {
    const qos = qosName(sc, j.parts[0]);
    running.set(qos, (running.get(qos) ?? 0) + 1);
    userRunning.set(j.user + "/" + qos, (userRunning.get(j.user + "/" + qos) ?? 0) + 1);
  }
  const placed = new Map<string, number>();
  const userPlaced = new Map<string, number>();
  for (const w of q.waiters.filter((w) => w.placed)) {
    const qos = qosName(sc, w.placed!);
    placed.set(qos, (placed.get(qos) ?? 0) + 1);
    userPlaced.set(w.job.user_name + "/" + qos, (userPlaced.get(w.job.user_name + "/" + qos) ?? 0) + 1);
  }
  for (const p of [...GPU_PARTS, ...CPU_PARTS]) {
    const qos = qosName(sc, p);
    const cap = partitionPolicy(p, snap.policy).grpJobs ?? 0;
    if (cap > 0) {
      const room = Math.max(0, cap - (running.get(qos) ?? 0));
      if ((placed.get(qos) ?? 0) > room) {
        fail("QoS " + qos + " (GrpJobs " + cap + ", " + (running.get(qos) ?? 0) + " running) starts " + placed.get(qos) + " more", sc);
      }
      const expect = cap - (running.get(qos) ?? 0) - (placed.get(qos) ?? 0);
      if (q.slotsLeft(p) !== expect) fail("slotsLeft(" + p + ") = " + q.slotsLeft(p) + ", expected " + expect, sc);
    }
    const ucap = partitionPolicy(p, snap.policy).maxJobsPerUser ?? 0;
    if (ucap > 0) {
      for (const user of ["u1", "u2", "u3"]) {
        const key = user + "/" + qos;
        if ((userPlaced.get(key) ?? 0) > Math.max(0, ucap - (userRunning.get(key) ?? 0))) {
          fail("user " + user + " in QoS " + qos + " (MaxJobsPerUser " + ucap + ", " + (userRunning.get(key) ?? 0) + " running) starts " + userPlaced.get(key) + " more", sc);
        }
      }
    }
  }
}

/** P4: a waiter that has the queue to itself, fits one in-service node of
 *  a partition it may start in, and is not held, booked or stuck, starts in
 *  the queue play — so its claim is subtracted from every verdict. */
function checkLoneWaiter(sc: Scenario) {
  const job = sc.jobs.find((j) => !j.running);
  if (!job) return;
  const snap = buildSnapshot(sc);
  const w = queueModel(snap).waiters.find((x) => x.job.job_id === job.id)!;
  const gpu = GPU_PARTS.includes(job.parts[0]);
  const longestH = Math.max(0, ...sc.parts.filter((p) => GPU_PARTS.includes(p.name) === gpu).map((p) => sc.qos[p.qos].wallH));
  if (longestH > 0 && job.submitAgoMin * 60 > longestH * 3600) return;   // queue.ts rule 4: stuck
  const running = (qos: string, user?: string) => sc.jobs.filter((j) => j.running && qosName(sc, j.parts[0]) === qos && (!user || j.user === user)).length;
  const open = job.parts.filter((p) => {
    const q = qosOfPart(sc, p);
    return !(q.grpJobs > 0 && running(qosName(sc, p)) >= q.grpJobs) && !(q.maxJobsPerUser > 0 && running(qosName(sc, p), job.user) >= q.maxJobsPerUser);
  });
  const fits = open.flatMap((p) => sc.nodes.filter((n) => n.parts.includes(p) && isSchedulable(n)
    && n.cores - n.coresUsed >= job.cpus && n.memMb - n.memUsedMb >= job.memMb
    && (!gpu || n.gpus - n.gpusUsed >= job.gpus)).map((n) => p + " on " + n.name));
  if (fits.length && !w.placed) {
    fail("job " + job.id + " is alone in the queue and fits " + fits.join(", ") + ", but the queue play does not start it (kind " + w.kind + ")", sc, job.parts);
  }
}

/** -t values from short to long; 0 is "no limit", the longest. */
const TIMES = [1800, 3600, 4 * 3600, 86400, 0];

/** P5: a shorter walltime never gets a worse start verdict. */
function checkWalltime(sc: Scenario) {
  const snap = buildSnapshot(sc);
  const gpuPool = snap.pools.find((p) => p.id === "gpu")!;
  const label = (t: number) => (t ? "-t " + t / 60 + "m" : "no time limit (timeSec 0)");
  for (const p of GPU_PARTS) {
    for (const memMb of [0, 8000]) {
      const now = TIMES.map((t) => gpuStatus(snap, gpuPool, p, { memMb, timeSec: t }, NOW_MS).now);
      const count = TIMES.map((t) => gpuStartCount(snap, gpuPool, p, { memMb, timeSec: t }, NOW_MS));
      for (let a = 0; a < TIMES.length; a++) for (let b = a + 1; b < TIMES.length; b++) {
        if (now[b] && !now[a]) fail("gpuStatus(" + p + (memMb ? ", --mem " + memMb : "") + "): " + label(TIMES[b]) + " starts now (" + now[b] + ") but " + label(TIMES[a]) + " queues", sc, [p]);
        if (count[b] > count[a]) fail("gpuStartCount(" + p + (memMb ? ", --mem " + memMb : "") + "): " + label(TIMES[b]) + " starts " + count[b] + " GPUs but " + label(TIMES[a]) + " only " + count[a], sc, [p]);
      }
    }
  }
  for (const p of CPU_PARTS) {
    for (const cores of [0, 1, 4]) {
      const v = TIMES.map((t) => liveCpuStart(snap, p, { cores, timeSec: t }));
      for (let a = 0; a < TIMES.length; a++) for (let b = a + 1; b < TIMES.length; b++) {
        if (v[b] === "now" && v[a] !== "now") fail("liveCpuStart(" + p + ", " + (cores || "default") + " cores): " + label(TIMES[b]) + " starts now but " + label(TIMES[a]) + " queues", sc, [p]);
      }
    }
  }
}

/** P6: fewer cores or less --mem never gets a worse CPU verdict, and the
 *  slider ends cpuStartLimits / cpuStartMemMb find by binary search sit
 *  exactly where liveCpuStart flips. */
function checkSmaller(sc: Scenario) {
  const snap = buildSnapshot(sc);
  for (const p of CPU_PARTS) {
    const most = sc.nodes.filter((n) => n.parts.includes(p)).reduce((s, n) => s + n.cores, 0);
    const capCores = qosOfPart(sc, p).maxCores;
    const full = queueModel(snap).groupFull(p);
    for (const nodes of [0, 1, 2]) {
      for (const memMb of [0, 4000]) {
        const ok = (cores: number) => liveCpuStart(snap, p, { cores, nodes, memMb }) === "now";
        const where = "liveCpuStart(" + p + (nodes ? ", -N " + nodes : "") + (memMb ? ", --mem " + memMb : "") + ")";
        const lo = Math.max(1, nodes);
        let prev = ok(lo);
        for (let c = lo + 1; c <= most; c++) {
          const cur = ok(c);
          if (cur && !prev) fail(where + ": " + c + " cores start now but " + (c - 1) + " queue", sc, [p]);
          prev = cur;
        }
        if (full) continue;
        const lim = cpuStartLimits(snap, p, { nodes, memMb })!;
        const m = lim.maxCores;
        if (m > 0 && !ok(m)) fail("cpuStartLimits(" + p + (nodes ? ", -N " + nodes : "") + (memMb ? ", --mem " + memMb : "") + ") says " + m + " cores start now, but " + where + " queues them", sc, [p]);
        if (m === 0 && ok(lo)) fail("cpuStartLimits(" + p + ") says nothing starts, but " + where + " starts " + lo + " cores", sc, [p]);
        if (m > 0 && !(capCores && m + 1 > capCores) && ok(m + 1)) fail("cpuStartLimits(" + p + (nodes ? ", -N " + nodes : "") + (memMb ? ", --mem " + memMb : "") + ") stops at " + m + " cores, but " + where + " starts " + (m + 1), sc, [p]);
      }
      for (const cores of [1, 2, 4]) {
        if (cores < nodes) continue;
        const ok = (memMb: number) => liveCpuStart(snap, p, { cores, nodes, memMb }) === "now";
        const where = "liveCpuStart(" + p + ", " + cores + " cores" + (nodes ? ", -N " + nodes : "") + ")";
        let prev = ok(500);
        for (let m = 1000; m <= 64000; m += 500) {
          const cur = ok(m);
          if (cur && !prev) fail(where + ": --mem " + m + " starts now but --mem " + (m - 500) + " queues", sc, [p]);
          prev = cur;
        }
        if (full) continue;
        const mem = cpuStartMemMb(snap, p, cores, nodes);
        if (mem > 0 && !ok(mem)) fail("cpuStartMemMb(" + p + ", " + cores + " cores) says --mem " + mem + " starts now, but " + where + " queues it", sc, [p]);
        if (ok(mem + 1)) fail("cpuStartMemMb(" + p + ", " + cores + " cores" + (nodes ? ", -N " + nodes : "") + ") stops at --mem " + mem + ", but " + where + " starts --mem " + (mem + 1), sc, [p]);
      }
    }
  }
}

/** One GPU's share of the partition's default request, restated from the
 *  rule documented in gpu-availability.ts (points 1-2) and slurm.ts
 *  capPerGpu: the request's cores (and DefMemPerCPU x those cores, or the
 *  hardware share when DefMemPerCPU is unset), capped by the largest node's
 *  per-GPU share and by the QoS MaxTRES per GPU. */
function defaultNeed(sc: Scenario, p: string) {
  const part = partOf(sc, p);
  const q = qosOfPart(sc, p);
  const gpuNodes = sc.nodes.filter(isGpuNode);
  const slots = Math.max(1, Math.max(0, ...gpuNodes.map((n) => n.gpus)) || 1);
  const hwCores = Math.max(1, Math.floor(Math.max(0, ...gpuNodes.map((n) => n.cores)) / slots));
  const hwMem = Math.floor(Math.max(0, ...gpuNodes.map((n) => n.memMb)) / slots);
  const perGpu = Math.max(1, q.maxGpus || 1);
  const capCores = q.maxCores ? Math.ceil(q.maxCores / perGpu) : Infinity;
  const capMem = q.maxMemGb ? Math.ceil((q.maxMemGb * 1024) / perGpu) : Infinity;
  const cores = Math.max(1, Math.min(part.defCores, hwCores, capCores));
  const memMb = Math.max(0, Math.min(part.defMemPerCpu ? cores * part.defMemPerCpu : hwMem, hwMem, capMem));
  return { gpus: 1, cores, memMb };
}

/** P7: a GPU partition's "starts now" rests on an in-service, unbooked node
 *  of that partition with room for the default request's per-GPU need once
 *  the queue has taken its claim — all checked on the nodes, not on the
 *  fit's own rows. */
function checkOwnNodes(sc: Scenario) {
  const snap = buildSnapshot(sc);
  const pool = snap.pools.find((p) => p.id === "gpu")!;
  const q = queueModel(snap);
  for (const p of GPU_PARTS) {
    if (gpuStatus(snap, pool, p, {}, NOW_MS).now !== "clear") continue;
    const need = defaultNeed(sc, p);
    const open = sc.nodes.filter((n) => {
      const c = q.claims.get(n.name);
      return n.parts.includes(p) && isSchedulable(n) && !q.bookings.has(n.name)
        && n.gpus - n.gpusUsed - (c?.gpus ?? 0) >= need.gpus && n.cores - n.coresUsed - (c?.cores ?? 0) >= need.cores
        && n.memMb - n.memUsedMb - (c?.memMb ?? 0) >= need.memMb;
    });
    if (!open.length) fail("gpuStatus(" + p + ") says it starts now (clear), but no in-service, unbooked node of " + p + " has room for " + JSON.stringify(need) + " after the queue's claims", sc, [p]);
  }
}

describe("start verdict", () => {
  it("P1 placement-fits: selectNodes only returns placements the nodes and the request allow", () => {
    fc.assert(fc.property(freeNodesArb.chain((nodes) => fc.tuple(fc.constant(nodes), requestArb(nodes.map((n) => n.name)), topoArb)),
      ([nodes, req, leaves]) => { checkPlacement(nodes, req, leaves); }), { ...params, numRuns: RUNS * 5 });
  });
  it("P2 claims-fit: the queue play claims no more than each node has free, only for waiters that may run there", () => {
    fc.assert(fc.property(scenarioArb, holds(checkClaims)), params);
  });
  it("P3 caps-hold: the queue play starts no more jobs than GrpJobs and MaxJobsPerUser leave", () => {
    fc.assert(fc.property(scenarioArb, (sc) => { checkCaps(sc); }), params);
  });
  const lone = scenarioArb.map((sc): Scenario => {
    const first = sc.jobs.findIndex((j) => !j.running);
    return { ...sc, jobs: sc.jobs.filter((j, i) => j.running || i === first)
      .map((j) => (j.running ? j : { ...j, reason: "Priority", bookedOn: [], req: [], exc: [], nodes: 1 })) };
  });
  it("P4 lone-waiter-starts: a waiter alone in the queue that fits an in-service node is started", () => {
    fc.assert(fc.property(lone, holds(checkLoneWaiter)), params);
  });
  it("P5 shorter-never-worse: a shorter walltime never turns starts-now into queues", () => {
    fc.assert(fc.property(scenarioArb, holds(checkWalltime)), params);
  });
  it("P6 smaller-never-worse: fewer cores or less --mem never queues where more starts; the slider ends sit where it flips", () => {
    fc.assert(fc.property(scenarioArb, holds(checkSmaller)), { ...params, numRuns: Math.ceil(RUNS / 2) });
  });
  it("P7 own-nodes-only: a GPU partition's starts-now rests on a node of that partition with room", () => {
    fc.assert(fc.property(scenarioArb, holds(checkOwnNodes)), params);
  });
});
