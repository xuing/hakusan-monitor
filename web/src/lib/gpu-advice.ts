import {
  gpuBackfillTipCommand,
  gpuFitSnapshot,
  gpuFitTipCommand,
  type GpuBackfillTipData,
  type GpuFitInfo,
  type GpuFitTipData,
} from "./gpu-fit";
import { poolContenders, queueModel } from "./queue";
import { partitionCap } from "./slurm";
import type { Pool, Snapshot } from "@/types/snapshot";

export interface GpuPartitionAdvice {
  fit: GpuFitInfo;
  gpuTip: GpuFitTipData | null;
  backfillTip: GpuBackfillTipData | null;
  groupRunning: number;
  groupLimitReached: boolean;
}

/** One default-request advice pipeline shared by Overview and Partitions. */
export function gpuPartitionAdvice(snap: Snapshot, pool: Pool, partition: string, nowMs: number): GpuPartitionAdvice {
  const q = queueModel(snap);
  const groupLimitReached = q.groupFull(partition);
  const fit = gpuFitSnapshot(snap, pool, partitionCap(partition, snap.policy), partition);
  const gpuTip = fit.schedulable <= 0 && !groupLimitReached
    ? gpuFitTipCommand(fit, pool, poolContenders(snap, pool.id))
    : null;
  const backfillTip = !gpuTip && !groupLimitReached
    ? gpuBackfillTipCommand(fit, pool, q, nowMs)
    : null;
  return { fit, gpuTip, backfillTip, groupRunning: q.running(partition), groupLimitReached };
}
