// The words for a partition verdict, the same on the Overview and the
// Partitions page: one label per state, one sentence per reason.
import { coresText, type TFn } from "@/i18n";
import type { TranslationKey } from "@/i18n/en";
import { fmtMB, nf } from "@/lib/format";
import type { GpuFitInfo, GpuFitNeed, GpuFitNode } from "@/lib/gpu-fit";
import { gpuVerdict, type GpuStatus, type GpuVerdict } from "@/lib/gpu-partition";
import type { Tone } from "@/lib/slurm";

const GPU_TAG: Record<GpuVerdict, { tone: Tone; key: TranslationKey }> = {
  now: { tone: "ok", key: "verdict.now" },
  bypass: { tone: "warn", key: "verdict.bypass" },
  gap: { tone: "info", key: "verdict.gap" },
  queue: { tone: "warn", key: "verdict.queue" },
  maint: { tone: "neutral", key: "pool.maint" },
};

export function gpuVerdictTag(s: GpuStatus, t: TFn): { tone: Tone; label: string } {
  const tag = GPU_TAG[gpuVerdict(s)];
  return { tone: tag.tone, label: t(tag.key) };
}

/** Why the request queues, or how it starts now (backfill); "" when there
 *  is nothing to add. */
export function gpuReasonText(s: GpuStatus, t: TFn): string {
  const r = s.reason;
  if (!r) return s.now === "backfill" ? t("pool.queueBfOk") : "";
  switch (r.kind) {
    case "maint": return t("pool.queueReasonMaint");
    case "group": return t("pool.queueReasonGroup");
    case "no-node": return t("pool.queueReasonNoNode");
    case "no-gpu": return t("pool.queueReasonNoGpu");
    case "contested": return t("pool.queueReasonContested", { n: r.n });
    case "short": return gpuFitShortText(s.fit, t);
    case "ahead": return aheadText(r.n, `${nf(r.free)} ${t("unit.gpu")}`, t);
  }
}

/** Why a request queues while something is free: the jobs the scheduler
 *  places first take it. One fact, not the queue's whole census. */
export function aheadText(ahead: number, free: string | null, t: TFn): string {
  if (!free || ahead === 0) return t("pool.queueFactBusy");
  return t("pool.queueFactAhead", { free, n: ahead });
}

export function gpuFitShortText(fit: GpuFitInfo, t: TFn) {
  const best = fit.stranded[0];
  if (!best) return t("pool.queueReasonGpuFit");
  return t("pool.fitShort", {
    partition: fit.need.partition,
    need: resourceText(fit.need, t),
    node: best.node.name,
    free: nodeFreeText(best, t),
    missing: missingText(best, t),
  });
}

export function resourceText(need: GpuFitNeed, t: TFn) {
  return resourceParts(need.gpus, need.cores, need.memMb, t);
}

export function nodeFreeText(row: GpuFitNode, t: TFn) {
  return resourceParts(row.freeGpu, row.freeCores, row.freeMemMb, t);
}

export function missingText(row: GpuFitNode, t: TFn) {
  const parts = [];
  if (row.missingGpu > 0) parts.push(`${nf(row.missingGpu)} ${t("unit.gpu")}`);
  if (row.missingCores > 0) parts.push(coresText(t, row.missingCores));
  if (row.missingMemMb > 0) parts.push(`${fmtMemRaw(row.missingMemMb)} ${t("kpi.memory")}`);
  return parts.length ? parts.join(" / ") : "0";
}

export function resourceParts(gpus: number, cores: number, memMb: number, t: TFn) {
  return `${nf(gpus)} ${t("unit.gpu")} / ${nf(cores)} ${t("unit.cores")} / ${fmtMemRaw(memMb)}`;
}

/** Memory exactly as Slurm counts it ("255,970M"), for sizes a request must match. */
export function fmtMemRaw(mb: number) {
  return `${nf(Math.max(0, Math.round(mb)))}M`;
}

/** A pending or running job's size: "1 GPU · 26 cores · 250 GiB · 1 nodes". */
export function jobSizeText(job: { gpus: number; cpus: number; mem_mb?: number; min_memory_mb?: number; node_count?: number }, t: TFn, withNodes = false) {
  const parts = [];
  const mem = job.mem_mb ?? job.min_memory_mb ?? 0;
  if (job.gpus > 0) parts.push(`${job.gpus} ${t("unit.gpu")}`);
  if (job.cpus > 0) parts.push(coresText(t, job.cpus));
  if (mem > 0) parts.push(fmtMB(mem));
  if (withNodes && (job.node_count ?? 0) > 0) parts.push(`${job.node_count} ${t("spec.nodes")}`);
  return parts.join(" · ") || "—";
}
