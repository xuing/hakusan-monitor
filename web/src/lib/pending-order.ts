import { isLimitBlocked } from "@/lib/gpu-fit";
import type { RawJob } from "@/types/snapshot";

/** Reasons a job never leaves without someone acting on it: a dependency
 *  that can no longer be met, a hold, an account or QOS Slurm rejects. */
const NEVER_STARTS = new Set([
  "DependencyNeverSatisfied", "JobHeldAdmin", "JobHeldUser", "InvalidAccount", "InvalidQOS", "BadConstraints",
]);

/** 0 = the scheduler places it when resources free up, 1 = held back by a
 *  limit or a pending dependency, 2 = never starts on its own. */
export function pendingGroup(job: RawJob): 0 | 1 | 2 {
  const reason = String(job.state_reason || "");
  if (NEVER_STARTS.has(reason)) return 2;
  return isLimitBlocked(job) ? 1 : 0;
}

const plannedStart = (job: RawJob) => {
  const ms = Date.parse(job.start_est || "");
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
};

/** Pending jobs in the order they get their turn: jobs the scheduler can
 *  place, by the start its backfill plan gives them (squeue %S), then by
 *  priority (%Q; every partition here shares one PriorityTier, so the
 *  numbers compare across partitions); limit-held jobs after them; jobs
 *  that never start last. */
export function nextUpOrder(jobs: RawJob[]): RawJob[] {
  return [...jobs].sort((a, b) =>
    pendingGroup(a) - pendingGroup(b)
    || plannedStart(a) - plannedStart(b)
    || (b.priority ?? 0) - (a.priority ?? 0));
}
