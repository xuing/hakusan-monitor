// A pool's pending jobs, in the order they get their turn (lib/queue).
import { dayClockLabel } from "@/components/common/gpu-release-hint";
import { jobSizeText } from "@/components/common/verdict-text";
import { useLive } from "@/hooks/live-context";
import { reasonLabel, type TFn } from "@/i18n";
import { clusterMs } from "@/lib/cluster-time";
import { poolWaiters, turnOrder } from "@/lib/queue";
import type { Pool, RawJob } from "@/types/snapshot";

export function PendingJobs({ pool, t }: { pool: Pool; t: TFn }) {
  const { snap } = useLive();
  if (!snap) return null;
  // every waiting job, in the order it gets its turn (the box scrolls)
  const list = turnOrder(poolWaiters(snap, pool.id)).map((w) => w.job);
  if (list.length === 0) return null;
  return (
    <div className="mt-2 max-h-64 space-y-1 overflow-y-auto pr-1">
      {list.map((j) => (
        <PendingJobRow key={String(j.job_id)} job={j} t={t} />
      ))}
    </div>
  );
}

function PendingJobRow({ job, t }: { job: RawJob; t: TFn }) {
  const rawReason = job.state_reason || "None";
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-1.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-info-fg">{job.user_name}</span>
        <div className="flex items-center gap-2 font-mono text-muted-foreground">
          <span>{job.partition}</span>
          <span className="text-foreground">{jobSizeText(job, t, true)}</span>
        </div>
      </div>
      <div className="mt-1 truncate text-xs text-muted-foreground">
        {reasonLabel(t, rawReason)}
        {Number.isFinite(clusterMs(job.start_est)) && (
          <> · {t("pool.pendingStartEst", { when: dayClockLabel(job.start_est, t) })}</>
        )}
      </div>
    </div>
  );
}
