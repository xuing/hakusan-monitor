import { Bar } from "@/components/common/bar";
import { Empty } from "@/components/common/empty";
import { SectionCard } from "@/components/common/section-card";
import { Tag } from "@/components/common/tag";
import { useLive } from "@/hooks/use-live";
import { useResourceFilter } from "@/hooks/use-resource-filter";
import { poolLabel, useT, type TFn } from "@/i18n";
import type { TranslationKey } from "@/i18n/en";
import { poolCapacity, type PoolCapacity } from "@/lib/derive";
import { fmtMB, nf } from "@/lib/format";
import { matchPartition, partitionCap, type PartitionCap } from "@/lib/slurm";
import { cn } from "@/lib/utils";
import type { Partition, Pool } from "@/types/snapshot";

const PARTITION_POLICIES: Record<string, { title: TranslationKey; desc: TranslationKey }> = {
  DEF: { title: "policy.DEF", desc: "policy.DEF.desc" },
  TINY: { title: "policy.TINY", desc: "policy.TINY.desc" },
  SINGLE: { title: "policy.SINGLE", desc: "policy.SINGLE.desc" },
  LONG: { title: "policy.LONG", desc: "policy.LONG.desc" },
  SMALL: { title: "policy.SMALL", desc: "policy.SMALL.desc" },
  LARGE: { title: "policy.LARGE", desc: "policy.LARGE.desc" },
  XLARGE: { title: "policy.XLARGE", desc: "policy.XLARGE.desc" },
  X2LARGE: { title: "policy.X2LARGE", desc: "policy.X2LARGE.desc" },
  "LONG-L": { title: "policy.LONG-L", desc: "policy.LONG-L.desc" },
  MS_Castep: { title: "policy.MS_Castep", desc: "policy.MS_Castep.desc" },
  MS_Dmol3: { title: "policy.MS_Dmol3", desc: "policy.MS_Dmol3.desc" },
  MS_Forcite: { title: "policy.MS_Forcite", desc: "policy.MS_Forcite.desc" },
  MS_Compass: { title: "policy.MS_Compass", desc: "policy.MS_Compass.desc" },
  MS_Dftbplus: { title: "policy.MS_Dftbplus", desc: "policy.MS_Dftbplus.desc" },
  MS_Amorphous: { title: "policy.MS_Amorphous", desc: "policy.MS_Amorphous.desc" },
  MatStudio: { title: "policy.MatStudio", desc: "policy.MatStudio.desc" },
  "GPU-1": { title: "policy.GPU-1", desc: "policy.GPU-1.desc" },
  "GPU-S": { title: "policy.GPU-S", desc: "policy.GPU-S.desc" },
  "GPU-L": { title: "policy.GPU-L", desc: "policy.GPU-L.desc" },
  "GPU-1A": { title: "policy.GPU-1A", desc: "policy.GPU-1A.desc" },
  "GPU-LA": { title: "policy.GPU-LA", desc: "policy.GPU-LA.desc" },
  "VM-CPU": { title: "policy.VM-CPU", desc: "policy.VM-CPU.desc" },
  "VM-GPU-L": { title: "policy.VM-GPU-L", desc: "policy.VM-GPU-L.desc" },
  "VM-LM": { title: "policy.VM-LM", desc: "policy.VM-LM.desc" },
  i112: { title: "policy.i112", desc: "policy.i112.desc" },
};

function partitionPolicy(name: string): { title: TranslationKey; desc: TranslationKey } {
  return PARTITION_POLICIES[name] ?? { title: "policy.other", desc: "policy.other.desc" };
}

function isMaintPartition(p: Partition) {
  const down = (p.nodes_state.down ?? 0) + (p.nodes_state.drain ?? 0);
  return down >= p.nodes && p.nodes > 0;
}

function availableNodes(p: Partition) {
  return p.available_nodes ?? p.free_nodes ?? 0;
}

// ---- the hero metric: what you can realistically request right now -----------
// GPU jobs are bounded by free cards; single-node CPU jobs by the emptiest node;
// multi-node CPU jobs by free *whole* nodes (they need contiguous nodes to start).
type Hero = { n: number; unit: "cores" | "gpu" | "nodes"; capped: boolean };

function requestableNow(p: Partition, cap: PartitionCap, isGpu: boolean, pc: PoolCapacity): Hero {
  if (isGpu) {
    const free = p.gpu?.free ?? 0;
    return { n: Math.min(cap.maxGpus ?? free, free), unit: "gpu", capped: false };
  }
  if ((cap.maxNodes ?? 1) > 1) {
    return { n: pc.idleNodes, unit: "nodes", capped: false };
  }
  const limit = cap.maxCores ?? pc.emptiestNodeFree;
  const n = Math.min(limit, pc.emptiestNodeFree);
  return { n, unit: "cores", capped: cap.maxCores !== undefined && n < cap.maxCores };
}

function heroText(t: TFn, h: Hero): string {
  if (h.unit === "gpu") return `${nf(h.n)} ${t("unit.gpu")}`;
  if (h.unit === "nodes") return `${nf(h.n)} ${t("part.wholeNodes")}`;
  return `${nf(h.n)}c`;
}

function fmtCapMem(gb?: number) {
  if (!gb) return "";
  if (gb >= 1024) {
    const tb = gb / 1024;
    return `${Number.isInteger(tb) ? tb : tb.toFixed(1)}TB`;
  }
  return `${gb}GB`;
}

function fmtPolicyLimit(cap: PartitionCap, isGpu: boolean, nodesLabel: string) {
  const parts: string[] = [];
  if (isGpu && cap.maxGpus) parts.push(`${cap.maxGpus} GPU`);
  if (cap.maxCores) parts.push(`${nf(cap.maxCores)}c`);
  if (cap.maxMemGb) parts.push(fmtCapMem(cap.maxMemGb));
  if (cap.maxNodes) parts.push(`${nf(cap.maxNodes)} ${nodesLabel}`);
  if (cap.wall) parts.push(cap.wall);
  return parts.join(" / ") || "—";
}

export function PartitionPressure() {
  const { snap } = useLive();
  const { filter } = useResourceFilter();
  const t = useT();
  if (!snap) return null;

  const matched = snap.partitions.filter((p) => matchPartition(p, filter));
  // group partitions by their hardware pool — same nodes shown once, not 16×
  const groups = new Map<string, Partition[]>();
  for (const p of matched) {
    const k = p.pool ?? "other";
    const arr = groups.get(k) ?? [];
    arr.push(p);
    groups.set(k, arr);
  }
  const order = snap.pools.map((p) => p.id);
  const poolById = new Map(snap.pools.map((p) => [p.id, p]));
  const keys = [...groups.keys()].sort((a, b) =>
    Number(!!poolById.get(a)?.gpu?.maint) - Number(!!poolById.get(b)?.gpu?.maint)
      || order.indexOf(a) - order.indexOf(b),
  );

  return (
    <SectionCard title={t("section.partitions")} extra={`${matched.length} · ${t("part.requestNow")}`}>
      {keys.length === 0 ? (
        <Empty>—</Empty>
      ) : (
        <div className="space-y-5">
          {keys.map((k) => {
            const parts = groups.get(k)!.sort((a, b) =>
              Number(isMaintPartition(a)) - Number(isMaintPartition(b))
                || availableNodes(b) - availableNodes(a)
                || b.pressure - a.pressure,
            );
            const spec = parts[0].spec;
            const isGpu = parts[0].kind === "gpu";
            const pool = poolById.get(k);
            const pc = poolCapacity(snap, k);
            return (
              <div key={k}>
                <PoolHeader pool={pool} label={poolLabel(t, k)} spec={spec} isGpu={isGpu} pc={pc} t={t} />
                {parts.length > 1 && <p className="mb-1.5 text-[11px] text-muted-foreground/80">{t("part.shared")}</p>}
                <div className="divide-y divide-border">
                  {parts.map((p) => (
                    <PartitionRow key={p.name} p={p} isGpu={isGpu} pc={pc} t={t} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function PoolHeader({
  pool,
  label,
  spec,
  isGpu,
  pc,
  t,
}: {
  pool?: Pool;
  label: string;
  spec: Partition["spec"];
  isGpu: boolean;
  pc: PoolCapacity;
  t: TFn;
}) {
  const maint = isGpu && !!pool?.gpu?.maint;
  // every number is self-labelled: which dimension is "used", and used/total in raw units.
  const used = isGpu ? pool?.gpu?.used ?? 0 : pool?.cores.alloc ?? 0;
  const total = isGpu ? pool?.gpu?.total ?? 0 : pool?.cores.total ?? 0;
  const util = total ? used / total : 0;
  const unit = isGpu ? t("unit.gpu") : t("unit.cores");
  const dim = isGpu ? t("dim.gpu") : t("dim.cpu");
  return (
    <div className="mb-1.5 border-b border-border pb-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-semibold">{label}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {nf(pool?.nodes ?? 0)} {t("spec.nodes")} · {t("spec.perNode")}{" "}
          {spec.gpu_per_node > 0 && `${spec.gpu_per_node} GPU · `}
          {spec.cores_per_node}c · {fmtMB(spec.mem_per_node)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        {maint ? (
          <>
            <Tag tone="neutral">{t("pool.maint")}</Tag>
            <span>{t("pool.offline", { n: nf(pool?.gpu?.down ?? total) })}</span>
          </>
        ) : (
          <>
            <Bar value={util} className="w-24" />
            <span className="font-mono">
              {dim} {Math.round(util * 100)}% {t("kpi.used")} ({nf(used)}/{nf(total)} {unit})
            </span>
            <span>·</span>
            {isGpu ? (
              <span className="font-mono text-ok-fg">{nf(pool?.gpu?.free ?? 0)} {unit} {t("part.available")}</span>
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
          </>
        )}
      </div>
    </div>
  );
}

function PartitionRow({ p, isGpu, pc, t }: { p: Partition; isGpu: boolean; pc: PoolCapacity; t: TFn }) {
  const maint = isMaintPartition(p);
  const policy = partitionPolicy(p.name);
  const cap = partitionCap(p.name);
  const hero = requestableNow(p, cap, isGpu, pc);
  const canRun = !maint && hero.n > 0;

  return (
    <div className={maint ? "py-2 opacity-55" : "py-2"}>
      <div className="grid gap-x-3 gap-y-1 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{p.name}</div>
          <div className="truncate text-[11px] text-muted-foreground">{t(policy.title)}</div>
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <span className="text-[11px] text-muted-foreground">{t("part.requestNow")}</span>
            <span className={cn("font-mono text-base font-semibold", canRun ? "text-ok-fg" : "text-muted-foreground")}>
              {maint ? "—" : heroText(t, hero)}
              {hero.capped && !maint && (
                <span title={t("part.capHint")} className="ml-0.5 cursor-help align-super text-[10px] text-warn-fg">*</span>
              )}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {t("part.policyLimit")} {fmtPolicyLimit(cap, isGpu, t("spec.nodes"))}
            </span>
            <span className={cn("font-mono text-[11px]", p.jobs.pending > 0 ? "text-warn-fg" : "text-muted-foreground")}>
              {t("part.run")}{nf(p.jobs.running)} {t("part.pend")}{nf(p.jobs.pending)}
            </span>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">{t(policy.desc)}</div>
        </div>
        <div className="flex items-center sm:justify-end">
          {maint ? (
            <Tag tone="neutral">{t("pool.maint")}</Tag>
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
