import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { useLive } from "@/hooks/live-context";
import { useResourceFilter } from "@/hooks/resource-filter-context";
import { poolLabel, useT, type TFn } from "@/i18n";
import { nodeIsSchedulable } from "@/lib/derive";
import { nf, pct } from "@/lib/format";
import { poolGpuAvailability } from "@/lib/gpu-fit";
import { utilTone } from "@/lib/slurm";
import type { Pool, Snapshot } from "@/types/snapshot";

export function KpiCards() {
  const { snap } = useLive();
  const { filter } = useResourceFilter();
  const t = useT();
  if (!snap) return null;
  const pool = filter === "all" ? null : snap.pools.find((p) => p.id === filter);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {pool ? <PoolKpis pool={pool} snap={snap} t={t} /> : <ClusterKpis snap={snap} t={t} />}
    </div>
  );
}

function ClusterKpis({ snap, t }: { snap: Snapshot; t: TFn }) {
  const { nodes } = snap.totals;
  const q = snap.queue;
  return (
    <>
      <SplitCard label={t("kpi.nodes")} stats={[
        [nodes.available, t("kpi.schedulable"), "text-ok-fg"],
        [nodes.down, t("kpi.down"), "text-bad-fg"],
        [nodes.total, t("kpi.total"), "text-muted-foreground"],
      ]} />
      <BarKpi label={t("kpi.gpuNodes")} free={nodes.gpu_free} total={nodes.gpu_total} />
      <BarKpi label={t("kpi.cpuNodes")} free={nodes.cpu_free} total={nodes.cpu_total} />
      <SplitCard label={t("kpi.queue")} stats={[
        [q.running, t("kpi.running"), "text-ok-fg"],
        [q.pending, t("kpi.pending"), "text-warn-fg"],
      ]} />
    </>
  );
}

function BarKpi({ label, free, total }: { label: string; free: number; total: number }) {
  const ratio = total ? free / total : 0;
  return (
    <Card>
      <CardContent className="p-5">
        <Label>{label}</Label>
        <div className="tnum mt-1 text-2xl font-semibold leading-tight">
          <span className={free > 0 ? "text-ok-fg" : "text-muted-foreground"}>{nf(free)}</span>
          <span className="text-sm font-normal text-muted-foreground"> / {nf(total)}</span>
        </div>
        <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-ok transition-all duration-500" style={{ width: `${ratio * 100}%` }} />
        </div>
      </CardContent>
    </Card>
  );
}

function PoolKpis({ pool, snap, t }: { pool: Pool; snap: Snapshot; t: TFn }) {
  const isGpu = pool.kind === "gpu";
  const g = pool.gpu;
  const used = isGpu && g ? g.used : pool.cores.alloc;
  const total = isGpu && g ? g.total : pool.cores.total;
  // "可用" GPUs = what the pool card calls ready (shared verdict), not every
  // idle card — queue-claimed or resource-short ones are not available.
  const free = isGpu && g ? poolGpuAvailability(snap, pool, Date.now()).ready : pool.cores.free;
  // Same rule as the cluster card's total: in service and not held by the
  // scheduler (idle+mixed would count MIXED+PLANNED nodes too).
  const schedulable = snap.nodes.filter((n) => n.pool === pool.id && nodeIsSchedulable(n)).length;
  const unit = isGpu ? t("unit.gpu") : t("unit.cores");
  return (
    <>
      <GaugeKpi label={poolLabel(t, pool.id)} util={pool.util} value={nf(used)}
        hint={`${t("kpi.of")} ${nf(total)} ${unit}`} />
      <SplitCard label={t("part.available")} stats={[
        [free, unit, "text-ok-fg"],
        [
          isGpu ? pool.available_nodes : pool.idle_nodes,
          isGpu ? t("kpi.gpuNodes") : t("kpi.nodes"),
          "text-muted-foreground",
        ],
      ]} />
      <SplitCard label={t("kpi.nodes")} stats={[
        [schedulable, t("kpi.schedulable"), "text-ok-fg"],
        [pool.down_nodes, t("kpi.down"), "text-bad-fg"],
        [pool.nodes, t("kpi.total"), "text-muted-foreground"],
      ]} />
      <SplitCard label={t("kpi.queue")} stats={[
        [pool.queue.running, t("kpi.running"), "text-ok-fg"],
        [pool.queue.pending, t("kpi.pending"), "text-warn-fg"],
      ]} />
    </>
  );
}

function GaugeKpi({ label, util, value, hint }: { label: string; util: number; value: string; hint: string }) {
  const radius = 27;
  const circumference = 2 * Math.PI * radius;
  const tone = utilTone(util);
  const color = tone === "bad" ? "var(--red-10)" : tone === "warn" ? "var(--amber-10)" : "var(--green-10)";
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <div className="relative grid h-16 w-16 shrink-0 place-items-center" role="img" aria-label={`${label}: ${pct(util)}`}>
          <svg className="absolute inset-0 h-full w-full -rotate-90" viewBox="0 0 64 64" aria-hidden>
            <circle cx="32" cy="32" r={radius} fill="none" stroke="hsl(var(--muted))" strokeWidth="6" />
            <circle
              cx="32" cy="32" r={radius} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - Math.max(0, Math.min(1, util)))}
            />
          </svg>
          <span className="tnum relative text-xs font-semibold">{pct(util)}</span>
        </div>
        <div className="min-w-0">
          <Label>{label}</Label>
          <div className="tnum text-2xl font-semibold leading-tight">{value}</div>
          <div className="truncate text-xs text-muted-foreground">{hint}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function SplitCard({ label, stats }: { label: string; stats: [number, string, string][] }) {
  return (
    <Card>
      <CardContent className="p-5">
        <Label>{label}</Label>
        <div className="mt-2 flex items-end gap-4">
          {stats.map(([n, lbl, cls]) => (
            <div key={lbl}>
              <div className={`tnum text-2xl font-semibold leading-none ${cls}`}>{nf(n)}</div>
              <div className="mt-1 text-xs text-muted-foreground">{lbl}</div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

const Label = ({ children }: { children: ReactNode }) => (
  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</div>
);
