import { describe, expect, it } from "vitest";
import { gpuBackfillTipCommand, gpuFitFromNodes, gpuStrandedCount } from "./gpu-fit";
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
    );

    expect(fit.rawFree).toBe(0);
    expect(fit.schedulable).toBe(0);
    expect(fit.reservedNodes).toHaveLength(1);
    // the reserved idle card must surface as an amber count, not a bare "0"
    expect(gpuStrandedCount(fit)).toBe(1);
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
