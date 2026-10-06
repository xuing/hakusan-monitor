import { Fragment } from "react";
import { CopyButton } from "@/components/common/copy-button";
import { Empty } from "@/components/common/empty";
import { HoverHint } from "@/components/common/hover-hint";
import { dayClockLabel, GpuReleaseHint } from "@/components/common/gpu-release-hint";
import { SectionCard } from "@/components/common/section-card";
import { LivePending } from "@/components/common/live-pending";
import { PolicyLimitChips } from "@/components/common/policy-limit-chips";
import { Tag } from "@/components/common/tag";
import { UnitBlocks } from "@/components/common/unit-blocks";
import { gpuSegmentLabel } from "@/components/common/gpu-status";
import { useLive } from "@/hooks/live-context";
import { useResourceFilter } from "@/hooks/resource-filter-context";
import { coresText, poolTitle, useT, type TFn } from "@/i18n";
import type { TranslationKey } from "@/i18n/en";
import { poolCapacity, poolNodeStates, type PoolCapacity, type PoolNodeStates } from "@/lib/derive";
import { fmtMB, nf } from "@/lib/format";
import { fitHasClearSlot, partitionGpuAvailability, poolGpuAvailability } from "@/lib/gpu-fit";
import { queueModel } from "@/lib/queue";
import { maxJobGpus } from "@/lib/gpu-layout";
import type { GpuAvailability } from "@/lib/gpu-availability";
import { gpuPartitionAdvice, type GpuPartitionAdvice } from "@/lib/gpu-advice";
import { cpuPartitionStatus, cpuPartitionVerdict, type CpuPartitionStatus } from "@/lib/cpu-partition";
import {
  cpuProbeDetail,
  fmtPolicyLimit,
  policyLimitRows,
} from "@/lib/policy-hints";
import {
  allowsMultiNode,
  effectiveGpuLimit,
  isLicensePartition,
  matchPartition,
  partitionCap,
  partitionPolicy as slurmPartitionPolicy,
} from "@/lib/slurm";
import { cn } from "@/lib/utils";
import type { Partition, PolicySnapshot, Pool } from "@/types/snapshot";

/** A partition's title and description from the site's text
 *  (`policy.<name>` / `policy.<name>.desc`), else the generic pair. */
function partitionLabelPolicy(name: string, t: TFn): { title: TranslationKey; desc: TranslationKey } {
  const title = `policy.${name}` as TranslationKey;
  const desc = `policy.${name}.desc` as TranslationKey;
  return {
    title: t(title) !== title ? title : "policy.other",
    desc: t(desc) !== desc ? desc : "policy.other.desc",
  };
}

function isMaintPartition(p: Partition) {
  const down = (p.nodes_state.down ?? 0) + (p.nodes_state.drain ?? 0);
  return down >= p.nodes && p.nodes > 0;
}

function availableNodes(p: Partition) {
  return p.available_nodes ?? p.free_nodes ?? 0;
}

// ---- the hero metric: what you can realistically request right now -----------
// GPU jobs are bounded by free cards (CPU partitions read lib/cpu-partition).
type Hero = { n: number; unit: "cores" | "gpu" | "nodes"; capped: boolean };

function requestableNow(p: Partition, gpuSchedulable: number | null, jobGpus?: number): Hero {
  const free = p.gpu?.free ?? 0;
  // agree with the Overview verdict: a free GPU stranded on a node whose
  // leftover CPU/mem can't host the default request is NOT requestable
  const sched = Math.min(gpuSchedulable ?? free, free);
  // ...and never more than one job can hold (QoS gres cap, or the GPUs the
  // submit plugin pins per node x the node cap)
  return { n: Math.min(jobGpus ?? sched, sched), unit: "gpu", capped: false };
}

function heroText(t: TFn, h: Hero): string {
  if (h.unit === "gpu") return `${nf(h.n)} ${t("unit.gpu")}`;
  // "0 台整空节点" reads like a contradiction next to the queue tag — say it in words
  if (h.unit === "nodes") return h.n > 0 ? `${nf(h.n)} ${t("part.wholeNodes")}` : t("part.noWholeNodes");
  return coresText(t, h.n);
}

export function PartitionPressure() {
  const { snap } = useLive();
  const { filter } = useResourceFilter();
  const t = useT();
  if (!snap) {
    return (
      <LivePending fallback={<SectionCard bodyClassName="pt-4">
        <div className="space-y-3">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-lg bg-muted/40" />
          ))}
        </div>
      </SectionCard>} />
    );
  }

  const matched = snap.partitions.filter((p) => matchPartition(p, filter));
  // Group by hardware pool; app-specific partitions remain under the same pool.
  const groups = new Map<string, PartitionGroup>();
  for (const p of matched) {
    const poolKey = p.pool ?? "other";
    const group = groups.get(poolKey) ?? { key: poolKey, poolKey, parts: [] };
    group.parts.push(p);
    groups.set(poolKey, group);
  }
  const order = snap.pools.map((p) => p.id);
  const poolById = new Map(snap.pools.map((p) => [p.id, p]));
  const partitionGroups = [...groups.values()].sort((a, b) =>
    Number(!!poolById.get(a.poolKey)?.gpu?.maint) - Number(!!poolById.get(b.poolKey)?.gpu?.maint)
      || order.indexOf(a.poolKey) - order.indexOf(b.poolKey),
  );

  return (
    <SectionCard bodyClassName="pt-4">
      {partitionGroups.length === 0 ? (
        <Empty>—</Empty>
      ) : (
        <div className="space-y-5">
          {partitionGroups.map((group) => {
            const cpuRank = (p: Partition) => {
              if (p.kind === "gpu") return 0;
              if (queueModel(snap).groupFull(p.name)) return 1;
              const state = cpuPartitionStatus(snap, p.name).state;
              if (state === "now") return 0;
              if (state === "queued") return 2;
              if (state === "unknown") return 3;
              return 4;
            };
            const parts = group.parts.sort((a, b) =>
              Number(isMaintPartition(a)) - Number(isMaintPartition(b))
                || cpuRank(a) - cpuRank(b)
                || availableNodes(b) - availableNodes(a)
                || b.pressure - a.pressure,
            );
            const generalParts = parts.filter((p) => !isLicensePartition(p.name, snap.policy));
            const materialsParts = parts.filter((p) => isLicensePartition(p.name, snap.policy));
            const spec = parts[0].spec;
            const isGpu = parts[0].kind === "gpu";
            const pool = poolById.get(group.poolKey);
            const pc = poolCapacity(snap, group.poolKey);
            const nowMs = Date.now();
            const gpuAdviceByPartition = new Map(
              isGpu && pool
                ? parts.map((p) => [
                    p.name,
                    gpuPartitionAdvice(snap, pool, p.name, nowMs),
                  ] as const)
                : [],
            );
            // Same verdict as the Overview pool cards, filter chips and KPIs
            // (most permissive sibling policy wins), so a GPU cannot be
            // "available" on one page and reserved/short/queued on another.
            const gpuAvail = isGpu && pool ? poolGpuAvailability(snap, pool) : null;
            // Each row reads its own partition's view of the same verdict
            // (queue claims included), never the contention-blind fit count.
            const gpuAvailByPartition = new Map(
              isGpu && pool
                ? parts.map((p) => [p.name, partitionGpuAvailability(snap, pool, p.name)] as const)
                : [],
            );
            const idleNotReady = (a: GpuAvailability) =>
              a.segments.filter((s) => s.kind !== "ready" && s.kind !== "down" && s.kind !== "full")
                .reduce((sum, s) => sum + s.count, 0);
            return (
              <div key={group.key}>
                <PoolHeader
                  pool={pool}
                  label={poolTitle(t, pool, group.poolKey)}
                  spec={spec}
                  isGpu={isGpu}
                  pc={pc}
                  gpuAvail={gpuAvail}
                  nodeStates={poolNodeStates(snap, group.poolKey)}
                  generatedAt={snap.generated_at}
                  t={t}
                />
                {parts.length > 1 && <p className="mb-1.5 text-xs text-muted-foreground/80">{t("part.shared")}</p>}
                <div className="space-y-2">
                  {generalParts.length > 0 && (
                    <PartitionRows
                      label={materialsParts.length > 0 ? t("part.generalCpuPolicies") : ""}
                      parts={generalParts}
                      isGpu={isGpu}
                      cpuStatusFor={(p) => (!isGpu ? cpuPartitionStatus(snap, p.name) : null)}
                      gpuSlotsFor={(p) => gpuAvailByPartition.get(p.name)?.ready ?? null}
                      gpuClearFor={(p) =>
                        gpuAdviceByPartition.has(p.name)
                          ? fitHasClearSlot(gpuAdviceByPartition.get(p.name)!.fit, queueModel(snap).claims)
                          : null
                      }
                      gpuStrandedFor={(p) => {
                        const avail = gpuAvailByPartition.get(p.name);
                        return avail ? idleNotReady(avail) : 0;
                      }}
                      gpuAdviceFor={(p) => gpuAdviceByPartition.get(p.name) ?? null}
                      policy={snap.policy}
                      t={t}
                    />
                  )}
                  {materialsParts.length > 0 && (
                    <PartitionRows
                      label={t("part.materialsStudioGroup")}
                      note={t("part.materialsStudioNote")}
                      parts={materialsParts}
                      isGpu={isGpu}
                      cpuStatusFor={(p) => (!isGpu ? cpuPartitionStatus(snap, p.name) : null)}
                      gpuSlotsFor={() => null}
                      gpuClearFor={() => null}
                      gpuStrandedFor={() => 0}
                      gpuAdviceFor={() => null}
                      policy={snap.policy}
                      t={t}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

interface PartitionGroup {
  key: string;
  poolKey: string;
  parts: Partition[];
}

function PartitionRows({
  label,
  note,
  parts,
  isGpu,
  cpuStatusFor,
  gpuSlotsFor,
  gpuClearFor,
  gpuStrandedFor,
  gpuAdviceFor,
  policy,
  t,
}: {
  label: string;
  note?: string;
  parts: Partition[];
  isGpu: boolean;
  cpuStatusFor: (p: Partition) => CpuPartitionStatus | null;
  gpuSlotsFor: (p: Partition) => number | null;
  gpuClearFor: (p: Partition) => boolean | null;
  gpuStrandedFor: (p: Partition) => number;
  gpuAdviceFor: (p: Partition) => GpuPartitionAdvice | null;
  policy?: PolicySnapshot;
  t: TFn;
}) {
  return (
    <div>
      {label && (
        <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
          <span className="font-medium text-foreground">{label}</span>
          {note && <span className="text-muted-foreground/80">{note}</span>}
        </div>
      )}
      <div className="divide-y divide-border">
        {parts.map((p) => (
          <PartitionRow
            key={p.name}
            p={p}
            isGpu={isGpu}
            cpu={cpuStatusFor(p)}
            gpuSchedulable={gpuSlotsFor(p)}
            gpuClear={gpuClearFor(p)}
            gpuStranded={gpuStrandedFor(p)}
            gpuAdvice={gpuAdviceFor(p)}
            policy={policy}
            t={t}
          />
        ))}
      </div>
    </div>
  );
}

function PoolHeader({
  pool,
  label,
  spec,
  isGpu,
  pc,
  gpuAvail,
  nodeStates,
  generatedAt,
  t,
}: {
  pool?: Pool;
  label: string;
  spec: Partition["spec"];
  isGpu: boolean;
  pc: PoolCapacity;
  gpuAvail?: GpuAvailability | null;
  /** Nodes the scheduler holds (PLANNED/RESERVED), from the raw node list. */
  nodeStates: PoolNodeStates;
  generatedAt: number;
  t: TFn;
}) {
  const maint = isGpu && !!pool?.gpu?.maint;
  const gpuReady = gpuAvail?.ready ?? 0;
  // Every idle-but-not-takeable state, in the classifier's own order.
  const gpuBlocked = (gpuAvail?.segments ?? []).filter((s) => s.kind !== "ready" && s.kind !== "full");
  // every number is self-labelled: which dimension is "used", and used/total in raw units.
  const used = isGpu ? pool?.gpu?.used ?? 0 : pool?.cores.alloc ?? 0;
  const total = isGpu ? pool?.gpu?.total ?? 0 : pool?.cores.total ?? 0;
  const util = total ? used / total : 0;
  const unit = isGpu ? t("unit.gpu") : t("unit.cores");
  const dim = isGpu ? t("dim.gpu") : t("dim.cpu");
  // one cell per node, by the shared rule (poolNodeStates) the pool card draws too
  const ns = nodeStates;
  const blocks = isGpu
    ? {
        free: pool?.gpu?.free ?? 0,
        used: pool?.gpu?.used ?? 0,
        reserved: pool?.gpu?.reserved ?? 0,
        down: pool?.gpu?.down ?? 0,
        total: pool?.gpu?.total ?? 0,
        unit: t("unit.gpu"),
      }
    : {
        free: ns.idle + ns.partial,
        used: ns.full,
        reserved: ns.held,
        down: ns.down,
        total: pool?.nodes ?? 0,
        unit: t("spec.nodes"),
      };
  return (
    <div className="mb-1.5 border-b border-border pb-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-semibold">{label}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {nf(pool?.nodes ?? 0)} {t("spec.nodes")} · {t("spec.perNode")}{" "}
            {spec.gpu_per_node > 0 && `${spec.gpu_per_node} GPU · `}
            {coresText(t, spec.cores_per_node)} · {fmtMB(spec.mem_per_node)}
          </span>
        </div>
        {isGpu && <GpuReleaseHint next={pool?.gpu?.next_free} generatedAt={generatedAt} />}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {/* CPU: only wholly idle nodes are green; a node with a few spare
            cores is amber — green for "8 of 256 cores free" overstated it. */}
        <UnitBlocks
          {...blocks}
          schedulable={isGpu ? gpuReady : ns.idle}
          strandedLabel={isGpu ? undefined : t("blocks.partlyFree")}
        />
        {maint ? (
          <>
            <Tag tone="neutral">{t("pool.maint")}</Tag>
            <span>{t("pool.offline", { n: nf(pool?.gpu?.down ?? total) })}</span>
          </>
        ) : (
          <>
            {/* the CPU bar counts nodes (one cell each) while the text after it
                counts cores — name the nodes in the bar's own colours */}
            {!isGpu && (
              <>
                <span className="font-mono">
                  {t("part.nodesPrefix")}{" "}
                  {([
                    ["part.nodesIdle", ns.idle, "text-ok-fg"],
                    ["part.nodesPartial", ns.partial, "text-warn-fg"],
                    ["part.nodesHeld", ns.held, "text-warn-fg"],
                    ["part.nodesFull", ns.full, "text-bad-fg"],
                    ["part.nodesDown", ns.down, "text-muted-foreground"],
                  ] as const)
                    .filter(([, n]) => n > 0)
                    .map(([key, n, cls], i) => (
                      <Fragment key={key}>
                        {i > 0 && " · "}
                        <span className={cls}>{t(key, { n: nf(n) })}</span>
                      </Fragment>
                    ))}
                </span>
                <span>·</span>
              </>
            )}
            <span className="font-mono">
              {dim} {Math.round(util * 100)}% {t("kpi.used")} ({nf(used)}/{nf(total)} {unit})
            </span>
            <span>·</span>
            {isGpu ? (
              // "available" means takeable now, exactly as on the pool cards —
              // a green zero would contradict the colour language, so grey it out
              <span className={cn("font-mono", gpuReady > 0 ? "text-ok-fg" : "text-muted-foreground")}>
                {nf(gpuReady)} {unit} {t("part.available")}
              </span>
            ) : pc.idleNodes > 0 ? (
              <>
                <span className="font-mono">{t("pool.idleNodes", { n: pc.idleNodes })}</span>
                <span>·</span>
                <span className="font-mono text-ok-fg">{nf(pc.freeCores)} {unit} {t("part.available")}</span>
              </>
            ) : (
              // no whole node is empty — say so, so "N cores free" doesn't look contradictory
              <span className="font-mono">
                <span className={pc.freeCores > 0 ? "text-ok-fg" : "text-muted-foreground"}>
                  {nf(pc.freeCores)} {unit} {t("part.available")}
                </span>
                {pc.freeCores > 0 && <span className="text-muted-foreground"> {t("pool.scatteredNote")}</span>}
              </span>
            )}
            {isGpu && gpuBlocked.map((segment) => (
              <Fragment key={segment.kind}>
                <span>·</span>
                <span className={cn("font-mono", segment.kind === "down" ? "text-muted-foreground" : "text-warn-fg")}>
                  {nf(segment.count)} {unit} {gpuSegmentLabel(segment.kind, t)}
                </span>
              </Fragment>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function PartitionRow({
  p,
  isGpu,
  cpu,
  gpuSchedulable,
  gpuClear,
  gpuStranded,
  gpuAdvice,
  policy,
  t,
}: {
  p: Partition;
  isGpu: boolean;
  cpu: CpuPartitionStatus | null;
  gpuSchedulable: number | null;
  gpuClear: boolean | null;
  gpuStranded: number;
  gpuAdvice: GpuPartitionAdvice | null;
  policy?: PolicySnapshot;
  t: TFn;
}) {
  const maint = isMaintPartition(p);
  const { snap } = useLive();
  // Pending jobs submitted to several partitions ("-p DEF,SMALL,SINGLE") wait
  // in each of them but start in one, so per-partition PD counts don't add up
  // to the pool total — say so where it applies.
  const pendShared = (snap?.jobs ?? []).filter((j) => {
    if (String(j.job_state).toUpperCase() !== "PENDING") return false;
    const parts = String(j.partition || "").split(",");
    return parts.length > 1 && parts.includes(p.name);
  }).length;
  const labelPolicy = partitionLabelPolicy(p.name, t);
  const runtimePolicy = slurmPartitionPolicy(p.name, policy);
  const q = snap ? queueModel(snap) : null;
  const limitRows = policyLimitRows(runtimePolicy, q?.running(p.name) ?? 0, t);
  const groupLimitReached = Boolean(q?.groupFull(p.name));
  const gpuTip = gpuAdvice?.gpuTip ?? null;
  const backfillTip = gpuAdvice?.backfillTip ?? null;
  const cap = partitionCap(p.name, policy);
  // the partition's node shape (scontrol) — with it, the GPU numbers count
  // what a job can really get (maxJobGpus)
  const gpuShape = isGpu && p.spec.gpu_per_node > 0
    ? { gpus: p.spec.gpu_per_node, cores: p.spec.cores_per_node, memMb: p.spec.mem_per_node, count: p.nodes }
    : undefined;
  const jobGpus = gpuShape
    ? maxJobGpus(cap, gpuShape, allowsMultiNode(cap, gpuShape.cores))
    : effectiveGpuLimit(cap).total;
  // CPU: the shared status (lib/cpu-partition) — the same numbers and tag as
  // the Overview quick-request table
  const probeState = cpu ? cpu.state : null;
  const hero: Hero = isGpu
    ? requestableNow(p, gpuSchedulable, jobGpus)
    : {
        n: cpu?.maxCores ?? 0,
        unit: "cores",
        // one node's free cores, under the policy cap — the hint says so
        // with the numbers (not when the count is the probe's default request)
        capped: Boolean(cpu && !cpu.spread && !cpu.fromProbe && cap.maxCores !== undefined
          && cpu.maxCores > 0 && cpu.maxCores < cap.maxCores),
      };
  // gpuClear === false means every free GPU slot is claimed by queued jobs
  // (or the node is PLANNED) — "can allocate" would be a false promise.
  const canRun = !maint && !groupLimitReached && (cpu
    ? cpuPartitionVerdict(cpu, t).tone === "ok"   // a "needs -L" row never reads "can request"
    : hero.n > 0 && gpuClear !== false);
  // GPU only: the hero count from bin-packing alone (schedulable via cores/
  // mem fit) understates what's on screen when nothing fits but the pool
  // still has idle cards — show that idle count instead of a bare "0", and
  // let color alone say whether the default request can actually have it.
  const gpuDisplayHero = isGpu && hero.n <= 0 && gpuStranded > 0 ? { ...hero, n: gpuStranded } : hero;
  const heroHasEstimate = Boolean(cpu?.estimate);
  const heroOverride =
    !maint && (probeState === "queued" || probeState === "failed")
      ? heroHasEstimate
        ? t("pool.cpuProbeStart", { time: dayClockLabel(cpu!.estimate!, t) })
        : "—" // the status Tag on the right already says queued/failed — don't repeat it here
      : null;
  // "可申请" only where the status tag agrees — a contested or capped slot
  // must not read "can request" beside "will queue".
  const heroLabel = !heroOverride
    ? hero.n > 0 && canRun
      ? t("part.requestNow")
      : null
    : heroHasEstimate
      ? t("col.startEst")
      : null;
  const cpuProbe = cpu?.probe ?? null;
  // the command the verdict is about (with the corrected -L where the plugin's
  // license name doesn't exist); none for a row that needs a -L of your own
  const showTestedCommand = Boolean(cpu && !maint && (probeState === "now" || probeState === "queued")
    && cpu.license.kind !== "required" && cpu.license.kind !== "missing");

  return (
    <div className={maint ? "rounded-md border border-dashed border-border bg-muted/20 px-2 py-2" : "py-2"}>
      <div className="grid gap-x-3 gap-y-1 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{p.name}</div>
          <div className="truncate text-xs text-muted-foreground">{t(labelPolicy.title)}</div>
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            {heroLabel && <span className="text-xs text-muted-foreground">{heroLabel}</span>}
            <span
              className={cn(
                "font-mono text-base font-semibold",
                canRun && heroOverride !== "—"
                  ? "text-ok-fg"
                  : isGpu && !maint && gpuDisplayHero.n > 0
                    ? "text-warn-fg"
                    : "text-muted-foreground",
              )}
            >
              {maint ? "—" : (heroOverride ?? heroText(t, gpuDisplayHero))}
              {!heroOverride && hero.capped && !maint && (
                <HoverHint text={t("part.capHint", { n: nf(hero.n), max: nf(cap.maxCores ?? 0) })} className="ml-0.5 align-super text-xs" />
              )}
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {t("part.policyLimit")} {fmtPolicyLimit(cap, isGpu, t, p.name, p.spec.mem_per_node, policy, gpuShape, p.spec.cores_per_node) || "—"}
            </span>
            <span className={cn("font-mono text-xs", p.jobs.pending > 0 ? "text-warn-fg" : "text-muted-foreground")}>
              {t("part.run")}{nf(p.jobs.running)} {t("part.pend")}{nf(p.jobs.pending)}
              {pendShared > 0 && (
                <HoverHint text={t("part.pendShared", { n: pendShared })} className="ml-0.5 align-super text-xs" />
              )}
            </span>
          </div>
          {t(labelPolicy.desc) && (
            <div className="mt-0.5 text-xs text-muted-foreground/80">
              {t(labelPolicy.desc)}
            </div>
          )}
          {gpuTip && (
            <div className="mt-0.5 text-xs text-warn-fg">
              {t("pool.quickGpuMemHint", { mem: gpuTip.mem })} · {gpuTip.node}
            </div>
          )}
          {backfillTip && (
            <div className="mt-0.5 text-xs text-info-fg">
              {t("pool.quickGpuBfHint", { t: backfillTip.t })} · {backfillTip.node}
            </div>
          )}
          <PolicyLimitChips rows={limitRows} />
          {cpu?.license.kind === "fixed" && !maint && (
            <div className="mt-0.5 text-xs text-warn-fg">
              {t("pool.licenseFixed", { bad: cpu.license.pluginDefault ?? "", good: cpu.license.name ?? "" })}
            </div>
          )}
          {cpu && !maint && (showTestedCommand || cpuProbe) && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              {showTestedCommand && (
                <span className="inline-flex max-w-full min-w-0 items-center gap-1 text-muted-foreground">
                  <span className="min-w-0 truncate font-mono text-foreground">{cpu.command}</span>
                  <CopyButton text={cpu.command} />
                </span>
              )}
              {cpuProbe && cpuProbe.cores > 0 && (
                <span className="font-mono text-muted-foreground">
                  {t("pool.cpuProbeNeed", { cores: cpuProbe.cores })}
                </span>
              )}
              {cpuProbe && cpuProbeDetail(cpuProbe, probeState, t) && (
                <span className="min-w-0 truncate text-muted-foreground">{cpuProbeDetail(cpuProbe, probeState, t)}</span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center sm:justify-end">
          {maint ? (
            <Tag tone="neutral">{t("pool.maint")}</Tag>
          ) : groupLimitReached ? (
            <Tag tone="warn">{t("part.willQueue")}</Tag>
          ) : cpu ? (
            <Tag tone={cpuPartitionVerdict(cpu, t).tone}>{cpuPartitionVerdict(cpu, t).label}</Tag>
          ) : gpuTip ? (
            <Tag tone="warn">{t("pool.optBypass")}</Tag>
          ) : backfillTip ? (
            <Tag tone="info">{t("pool.optGap")}</Tag>
          ) : canRun ? (
            <Tag tone="ok">{t("part.canAllocate")}</Tag>
          ) : (
            <Tag tone="warn">{t("part.willQueue")}</Tag>
          )}
        </div>
      </div>
    </div>
  );
}
