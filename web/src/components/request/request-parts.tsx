// The quick request panel's smaller pieces: hint buttons, the verdict pill,
// the backfill tip and the stranded-GPU explanation.
import { Link2, Link2Off } from "lucide-react";
import { jobSizeText, missingText, nodeFreeText, resourceParts, resourceText } from "@/components/common/verdict-text";
import { Tag } from "@/components/common/tag";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type TFn } from "@/i18n";
import { clusterClock } from "@/lib/cluster-time";
import { slotContenders, type GpuBackfillTipData, type GpuFitInfo, type GpuFitNode } from "@/lib/gpu-fit";
import { type Waiter } from "@/lib/queue";
import { type Tone } from "@/lib/slurm";
import { cn } from "@/lib/utils";

/** 🔗 between cores and --mem: linked, the memory is cores x the default
 *  per core and follows the core slider; a hand-set --mem unlinks it, and a
 *  click links it again (or pins the current value). */
export function MemLinkToggle({ linked, per, onToggle, t }: { linked: boolean; per: string; onToggle: () => void; t: TFn }) {
  const Icon = linked ? Link2 : Link2Off;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={linked}
          aria-label={linked ? t("pool.memLinkedTip", { per }) : t("pool.memUnlinkedTip")}
          className={cn(
            "ml-1 inline-flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-muted",
            linked ? "text-info-fg" : "text-muted-foreground",
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs leading-relaxed">
        {linked ? t("pool.memLinkedTip", { per }) : t("pool.memUnlinkedTip")}
      </TooltipContent>
    </Tooltip>
  );
}

/** The one-click fix after a hint: sets the value the hint names. */
export function HintAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="ml-1.5 whitespace-nowrap font-medium text-info-fg underline-offset-2 hover:underline">
      {label}
    </button>
  );
}

/** The verdict pill inside the always-dark command box. */
export function CommandVerdict({ tone, label }: { tone: Tone; label: string }) {
  const cls: Record<Tone, string> = {
    ok: "bg-emerald-500/15 text-emerald-300",
    warn: "bg-amber-500/15 text-amber-300",
    bad: "bg-red-500/15 text-red-300",
    info: "bg-sky-500/15 text-sky-300",
    neutral: "bg-zinc-500/20 text-zinc-300",
  };
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold", cls[tone])}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}


export function GpuBackfillQuickTip({
  tip,
  variant,
  forced,
  applied,
  onApply,
  t,
}: {
  tip: GpuBackfillTipData;
  /** script: normal -t advice · switch: salloc can't -t, offer script mode · fits: gap ≥ the pinned walltime, only --mem needed */
  variant: "script" | "switch" | "fits";
  /** the plugin-pinned interactive walltime label ("12h"), from the policy */
  forced: string;
  applied: boolean;
  onApply: () => void;
  t: TFn;
}) {
  const until = clusterClock(tip.untilMs);
  const text =
    variant === "switch"
      ? tip.mem
        ? t("pool.bfTipSalloc", { node: tip.node, until, mem: tip.mem, t: tip.t, forced })
        : t("pool.bfTipSallocTime", { node: tip.node, until, t: tip.t, forced })
      : variant === "fits"
        ? t("pool.bfTipFits", { node: tip.node, until, mem: tip.mem, forced })
        : tip.mem
          ? t("pool.bfTipText", { node: tip.node, until, mem: tip.mem, t: tip.t })
          : t("pool.bfTipTextTime", { node: tip.node, until, t: tip.t });
  const applyLabel =
    variant === "switch"
      ? t("pool.bfTipSallocApply")
      : variant === "fits"
        ? t("pool.fitTipApply", { mem: tip.mem })
        : tip.mem
          ? t("pool.bfTipApply", { mem: tip.mem, t: tip.t })
          : t("pool.bfTipApplyTime", { t: tip.t });
  return (
    <div className="mt-2 rounded-md border border-info/40 bg-info-soft/45 px-2 py-1.5 text-xs leading-relaxed">
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag tone="info">{t("pool.bfTip")}</Tag>
        <span className="text-foreground">{text}</span>
        <button
          type="button"
          onClick={onApply}
          className={cn(
            "rounded border px-1.5 py-0.5 font-medium transition-colors",
            applied
              ? "border-ok/40 bg-ok-soft text-ok-fg"
              : "border-info/45 bg-background/80 text-info-fg hover:bg-info-soft",
          )}
        >
          {applied ? t("pool.fitTipApplied") : applyLabel}
        </button>
      </div>
    </div>
  );
}

function strandedTipNode(fit: GpuFitInfo | null) {
  return fit?.stranded.find((row) => row.freeGpu >= 1 && row.freeCores >= fit.need.cores && row.freeMemMb > 1024) ?? null;
}

export function GpuFitExplanation({ fit, contenders, t }: { fit: GpuFitInfo; contenders: Waiter[]; t: TFn }) {
  const rows = fit.stranded.slice(0, 4);
  if (rows.length === 0) return null;
  const more = Math.max(0, fit.stranded.length - rows.length);
  const best = strandedTipNode(fit) ?? fit.stranded[0];
  const contested = best ? slotContenders(best, contenders) : 0;
  return (
    <div className="mt-2 rounded-md border border-warn/35 bg-warn-soft/45 px-2.5 py-2 text-xs leading-relaxed">
      <div className="flex flex-wrap items-center gap-1.5">
        <Tag tone="warn">{t("pool.fitBlocked")}</Tag>
        <span className="text-foreground">{t("pool.fitNeed", { partition: fit.need.partition, need: resourceText(fit.need, t) })}</span>
      </div>
      {contested > 0 && (
        <div className="mt-1 font-medium text-warn-fg">{t("pool.fitContestedNote", { n: contested })}</div>
      )}
      <div className="mt-1 text-muted-foreground">
        {t("pool.fitRawFree", { gpu: fit.rawFree, nodes: fit.stranded.length, sched: fit.schedulable })}
      </div>
      <div className="mt-1.5 space-y-1">
        {rows.map((row) => (
          <GpuFitNodeRow key={row.node.name} row={row} t={t} />
        ))}
      </div>
      {more > 0 && <div className="mt-1 text-muted-foreground">{t("pool.fitMoreNodes", { n: more })}</div>}
    </div>
  );
}

function GpuFitNodeRow({ row, t }: { row: GpuFitNode; t: TFn }) {
  const occupants = row.occupants.slice(0, 3);
  const more = Math.max(0, row.occupants.length - occupants.length);
  const allocated = allocatedResourceText(row, t);
  return (
    <div className="rounded-md border border-border/70 bg-background/70 px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-mono text-info-fg">{row.node.name}</span>
        <span className="font-mono text-muted-foreground">
          {t("pool.fitNodeLeft", { free: nodeFreeText(row, t) })}
        </span>
        <span className="font-mono text-bad-fg">{t("pool.fitNodeMissing", { missing: missingText(row, t) })}</span>
      </div>
      {allocated && <div className="mt-0.5 font-mono text-muted-foreground">{t("pool.fitNodeAllocated", { used: allocated })}</div>}
      {occupants.length > 0 && (
        <div className="mt-0.5 text-muted-foreground">
          {t("pool.fitOccupants")}:{" "}
          {occupants.map((job, i) => (
            <span key={String(job.job_id)} className="font-mono">
              {i > 0 ? " · " : ""}
              {job.user_name} #{job.job_id} {job.partition} ({jobSizeText(job, t)})
            </span>
          ))}
          {more > 0 && <span className="font-mono"> · +{more}</span>}
        </div>
      )}
    </div>
  );
}

function allocatedResourceText(row: GpuFitNode, t: TFn) {
  if (row.usedGpu <= 0 && row.node.alloc_cpus <= 0 && row.node.alloc_memory <= 0) return "";
  return resourceParts(row.usedGpu, row.node.alloc_cpus, row.node.alloc_memory, t);
}

