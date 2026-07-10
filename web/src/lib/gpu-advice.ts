import {
  gpuBackfillTipCommand,
  gpuFitSnapshot,
  gpuFitTipCommand,
  type GpuBackfillTipData,
  type GpuFitInfo,
  type GpuFitTipData,
} from "./gpu-fit";
import { partitionCap, partitionPolicy } from "./slurm";
import type { Pool, RawJob, Snapshot } from "@/types/snapshot";

export interface GpuPartitionAdvice {
  fit: GpuFitInfo;
  gpuTip: GpuFitTipData | null;
  backfillTip: GpuBackfillTipData | null;
  groupRunning: number;
  groupLimitReached: boolean;
}

/** One default-request advice pipeline shared by Overview and Partitions. */
export function gpuPartitionAdvice(
  snap: Snapshot,
  pool: Pool,
  partition: string,
  pendingActive: RawJob[],
  nowMs: number,
  requestSec: number,
): GpuPartitionAdvice {
  const cap = partitionCap(partition, snap.policy);
  const policy = partitionPolicy(partition, snap.policy);
  const groupRunning = partitionRunningJobs(snap.jobs, partition);
  const groupLimitReached = Boolean(policy.grpJobs && groupRunning >= policy.grpJobs);
  const fit = gpuFitSnapshot(snap, pool, cap, partition);
  const gpuTip = fit.schedulable <= 0 && !groupLimitReached
    ? gpuFitTipCommand(fit, pool, pendingActive, nowMs, requestSec)
    : null;
  const backfillTip = !gpuTip && !groupLimitReached
    ? gpuBackfillTipCommand(fit, pool, pendingActive, nowMs, requestSec)
    : null;
  return { fit, gpuTip, backfillTip, groupRunning, groupLimitReached };
}

export function partitionRunningJobs(jobs: RawJob[], partition: string) {
  let running = 0;
  for (const job of jobs) {
    if (!String(job.partition || "").split(",").includes(partition)) continue;
    if (String(job.job_state || "").toUpperCase() === "RUNNING") running += 1;
  }
  return running;
}
