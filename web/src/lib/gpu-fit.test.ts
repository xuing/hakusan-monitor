import { describe, expect, it } from "vitest";
import { fitHasClearSlot, gpuBackfillTipCommand, gpuFitFromNodes, gpuNodeFacts, slotContenders } from "./gpu-fit";
import { queueModel, type QueueInput } from "./queue";
import { gpuAvailability } from "./gpu-availability";
import { REQUEST_GPU_1 } from "./gpu-availability.fixtures";
import type { Pool, RawJob, RawNode } from "@/types/snapshot";

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
  // both of the node's GPUs: one is busy until 14:00, so Slurm holds the
  // node (PLANNED) for this job instead of starting it now
  node_count: 1,
  cpus: 52,
  gpus: 2,
  tres_req_str: "gres/gpu:nvidia_a40=2",
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
  const fit = () => gpuFitFromNodes([plannedNode], [], pool, { maxGpus: 1, maxCores: 26, maxMemGb: 256 }, "GPU-1", REQUEST_GPU_1);
  const queue = (jobs: RawJob[]) => queueModel(snapOf([plannedNode], jobs));

  it("keeps PLANNED GPUs out of free totals but exposes a bounded gap", () => {
    expect(fit().rawFree).toBe(0);
    expect(fit().schedulable).toBe(0);
    expect(fit().reservedNodes).toHaveLength(1);
    // the reserved idle card must surface as an amber count, not a bare "0"
    expect(gpuAvailability(gpuNodeFacts([plannedNode], pool, new Map()), REQUEST_GPU_1).segments)
      .toEqual([{ kind: "reserved", count: 1 }]);
    expect(gpuBackfillTipCommand(fit(), pool, queue([reservation]), Date.parse("2026-07-10T12:00:00")))
      .toMatchObject({ node: "spcc-a40g13", mem: "240G", t: "01:45:00" });
  });

  it("does not advertise a gap without a matching scheduler booking", () => {
    expect(gpuBackfillTipCommand(fit(), pool, queue([]), Date.parse("2026-07-10T12:00:00"))).toBeNull();
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
    cpus: 26,
    gpus: 1,
    tres_req_str: "gres/gpu:nvidia_a40=1",
    min_memory_mb: 256_000,
    ...overrides,
  };
}

function snapOf(nodes: RawNode[], jobs: RawJob[]): QueueInput {
  return { nodes, jobs, pools: [pool], part_pool: { "GPU-1": "a40" }, policy: undefined, generated_at: 0 };
}

describe("a stranded slot and the queue", () => {
  const nodes = [idleNode("spcc-cld-gl02"), idleNode("spcc-cld-gl03")];
  const fit = gpuFitFromNodes(nodes, [], pool, { maxGpus: 1, maxCores: 26, maxMemGb: 256 }, "GPU-1", REQUEST_GPU_1);
  const row = (name: string) => fit.fitNodes.find((candidate) => candidate.node.name === name)!;
  const contenders = (jobs: RawJob[]) => queueModel(snapOf(nodes, jobs)).waiters.filter((w) => w.kind === "next");

  it("counts only waiters that may run on the node", () => {
    const pinned = contenders([waiter({ req_nodes: "spcc-cld-gl02" })]);
    expect(slotContenders(row("spcc-cld-gl02"), pinned)).toBe(1);
    expect(slotContenders(row("spcc-cld-gl03"), pinned)).toBe(0);
    const excluding = contenders([waiter({ exc_nodes: "spcc-cld-gl02" })]);
    expect(slotContenders(row("spcc-cld-gl02"), excluding)).toBe(0);
    expect(slotContenders(row("spcc-cld-gl03"), excluding)).toBe(1);
  });

  it("keeps SchedNodes a movable plan rather than a hard node constraint", () => {
    const planned = contenders([waiter({ sched_nodes: "spcc-cld-gl02" })]);
    expect(slotContenders(row("spcc-cld-gl03"), planned)).toBe(1);
  });

  it("leaves a slot clear until the waiters have taken all four", () => {
    const claims = (n: number) => queueModel(snapOf(nodes, [1, 2, 3, 4].slice(0, n).map((id) => waiter({ job_id: id })))).claims;
    expect(fitHasClearSlot(fit, claims(3))).toBe(true);
    expect(fitHasClearSlot(fit, claims(4))).toBe(false);
  });
});
