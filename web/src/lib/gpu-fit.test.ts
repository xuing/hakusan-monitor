import { describe, expect, it } from "vitest";
import {
  activePendingForPool,
  contendersForPool,
  fitHasClearSlot,
  gpuBackfillTipCommand,
  gpuFitFromNodes,
  gpuNodeFacts,
  queueClaims,
  slotContention,
} from "./gpu-fit";
import { gpuAvailability } from "./gpu-availability";
import { REQUEST_GPU_1 } from "./gpu-availability.fixtures";
import type { Pool, RawJob, RawNode, Snapshot } from "@/types/snapshot";

const pool = {
  id: "a40",
  kind: "gpu",
  gpu: { type: "nvidia_a40" },
} as Pool;

const plannedNode = {
  name: "spcc-a40g13",
  pool: "a40",
  state_bucket: "mixed",
  schedulable: false,
  state: ["MIXED", "PLANNED"],
  partitions: ["GPU-1"],
  cpus: 52,
  alloc_cpus: 26,
  cpu_load: "0",
  real_memory: 515_000,
  alloc_memory: 260_000,
  free_mem: 255_000,
  gres: "gpu:nvidia_a40:2",
  gres_used: "gpu:nvidia_a40:1",
  features: "",
  alloc_tres: "",
  cfg_tres: "",
  boot_time: "",
  reason: "",
} satisfies RawNode;

const reservation = {
  job_id: 42,
  user_name: "user01",
  account: "",
  partition: "GPU-1",
  job_state: "PENDING",
  state_reason: "Priority",
  node_count: 1,
  cpus: 26,
  gpus: 1,
  tres_req_str: "gres/gpu:nvidia_a40=1",
  container: "",
  submit_time: 0,
  end_time: "",
  start_est: "2026-07-10T14:00:00",
  time_left: "",
  name: "job",
  qos: "",
  nodelist: "",
  sched_nodes: "spcc-a40g13",
  time_used: "",
  time_limit: "7-00:00:00",
} satisfies RawJob;

describe("planned GPU backfill", () => {
  it("keeps PLANNED GPUs out of free totals but exposes a bounded gap", () => {
    const fit = gpuFitFromNodes(
      [plannedNode],
      [],
      pool,
      { maxGpus: 1, maxCores: 26, maxMemGb: 256 },
      "GPU-1",
      REQUEST_GPU_1,
    );

    expect(fit.rawFree).toBe(0);
    expect(fit.schedulable).toBe(0);
    expect(fit.reservedNodes).toHaveLength(1);
    // the reserved idle card must surface as an amber count, not a bare "0"
    expect(gpuAvailability(gpuNodeFacts([plannedNode], pool, [], Date.now()), REQUEST_GPU_1).segments)
      .toEqual([{ kind: "reserved", count: 1 }]);
    expect(gpuBackfillTipCommand(
      fit,
      pool,
      [reservation],
      Date.parse("2026-07-10T12:00:00"),
      12 * 60 * 60,
    )).toMatchObject({ node: "spcc-a40g13", mem: "240G", t: "1:45:00" });
  });

  it("does not advertise a gap without a matching scheduler reservation", () => {
    const fit = gpuFitFromNodes(
      [plannedNode],
      [],
      pool,
      { maxGpus: 1, maxCores: 26, maxMemGb: 256 },
      "GPU-1",
      REQUEST_GPU_1,
    );

    expect(gpuBackfillTipCommand(
      fit,
      pool,
      [],
      Date.parse("2026-07-10T12:00:00"),
      12 * 60 * 60,
    )).toBeNull();
  });
});

function idleNode(name: string): RawNode {
  return {
    ...plannedNode,
    name,
    state_bucket: "idle",
    schedulable: true,
    state: ["IDLE"],
    alloc_cpus: 0,
    alloc_memory: 0,
    gres_used: "",
  };
}

function waiter(overrides: Partial<RawJob> = {}): RawJob {
  return {
    ...reservation,
    state_reason: "Resources",
    start_est: "",
    sched_nodes: "",
    min_memory_mb: 256_000,
    ...overrides,
  };
}

describe("pending GPU job node eligibility", () => {
  const nodes = [idleNode("spcc-cld-gl02"), idleNode("spcc-cld-gl03")];
  const fit = gpuFitFromNodes(
    nodes,
    [],
    pool,
    { maxGpus: 1, maxCores: 26, maxMemGb: 256 },
    "GPU-1",
    REQUEST_GPU_1,
  );
  const row = (name: string) => fit.fitNodes.find((candidate) => candidate.node.name === name)!;

  it("does not let a one-node pinned waiter claim an idle sibling", () => {
    const pinned = waiter({ req_nodes: "spcc-cld-gl02" });

    expect(slotContention(row("spcc-cld-gl02"), [pinned]).contenders).toBe(1);
    expect(slotContention(row("spcc-cld-gl03"), [pinned]).contenders).toBe(0);
    expect(fitHasClearSlot(fit, [pinned], Date.now(), 12 * 60 * 60)).toBe(true);
  });

  it("keeps SchedNodes as a movable plan rather than a hard node constraint", () => {
    const planned = waiter({ sched_nodes: "spcc-cld-gl02" });

    expect(slotContention(row("spcc-cld-gl02"), [planned]).contenders).toBe(1);
    expect(slotContention(row("spcc-cld-gl03"), [planned]).contenders).toBe(1);
  });

  it("claims nothing for a waiter whose required host is full", () => {
    // --nodelist spcc-a40g01 (both GPUs busy) -N 2: the job cannot start, so
    // it must not take GPUs from the idle nodes either.
    const pinnedToFull = waiter({ req_nodes: "spcc-a40g01", node_count: 2, gpus: 2, cpus: 52, min_memory_mb: 512_000 });

    expect(queueClaims(fit.fitNodes, [pinnedToFull], Date.now()).size).toBe(0);
  });

  it("places a pinned waiter on its required host first", () => {
    const pinned = waiter({ req_nodes: "spcc-cld-gl03" });

    expect([...queueClaims(fit.fitNodes, [pinned], Date.now()).keys()]).toEqual(["spcc-cld-gl03"]);
  });

  it("lets one waiter claim one node, not every node it could use", () => {
    // Two idle 2-GPU nodes = four default-request slots. Every waiter fits
    // either node, but each takes one slot; a new request queues only once
    // all four are claimed. The old per-node check called both nodes taken
    // after ONE waiter — two dead jobs in front of nine idle A40 nodes read
    // "all 15 GPUs queue" (live, 2026-10-01).
    const waiters = [1, 2, 3, 4].map((id) => waiter({ job_id: id }));
    const now = Date.now();

    expect(fitHasClearSlot(fit, waiters.slice(0, 1), now, 12 * 60 * 60)).toBe(true);
    expect(fitHasClearSlot(fit, waiters.slice(0, 3), now, 12 * 60 * 60)).toBe(true);
    expect(fitHasClearSlot(fit, waiters, now, 12 * 60 * 60)).toBe(false);
    const claims = queueClaims(fit.fitNodes, waiters.slice(0, 1), now);
    expect([...claims.values()].reduce((sum, c) => sum + c.gpus, 0)).toBe(1);
  });

  it("honors explicit exclusions without hiding contention on eligible siblings", () => {
    const excluding = waiter({ exc_nodes: "spcc-cld-gl02" });

    expect(slotContention(row("spcc-cld-gl02"), [excluding]).contenders).toBe(0);
    expect(slotContention(row("spcc-cld-gl03"), [excluding]).contenders).toBe(1);
  });

  it("allows extra nodes when a multi-node request needs more than its required list", () => {
    const multiNode = waiter({
      req_nodes: "spcc-cld-gl02",
      node_count: 2,
      cpus: 52,
      gpus: 2,
      min_memory_mb: 512_000,
    });

    expect(slotContention(row("spcc-cld-gl03"), [multiNode]).contenders).toBe(1);
  });

  it("still removes QOS-blocked jobs before node contention is evaluated", () => {
    const limited = waiter({ state_reason: "QOSMaxJobsPerUserLimit" });

    expect(activePendingForPool([limited], { "GPU-1": "a40" }, "a40")).toEqual([]);
  });
});

describe("multi-pool waiters", () => {
  it("count only in the first-listed pool", () => {
    // -p GPU-1,GPU-1A starts in one pool; both pools losing a GPU to it
    // would undercount free capacity twice.
    const job = waiter({ partition: "GPU-1,GPU-1A" });
    const snap = { jobs: [job], part_pool: { "GPU-1": "a40", "GPU-1A": "a100" }, policy: undefined } as unknown as Snapshot;

    expect(contendersForPool(snap, "a40")).toHaveLength(1);
    expect(contendersForPool(snap, "a100")).toHaveLength(0);
  });
});
