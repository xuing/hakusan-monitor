import type { ReactNode } from "react";
import { ProgressCircle } from "@tremor/react";
import { Card, CardContent } from "@/components/ui/card";
import { useLive } from "@/hooks/use-live";
import { useResourceFilter } from "@/hooks/use-resource-filter";
import { poolLabel, useT, type TFn } from "@/i18n";
import { nf, pct } from "@/lib/format";
import { toneTremor, utilTone } from "@/lib/slurm";
import type { Pool, Snapshot } from "@/types/snapshot";

export function KpiCards() {
  const { snap } = useLive();
  const { filter } = useResourceFilter();
  const t = useT();
  if (!snap) return null;
  const pool = filter === "all" ? null : snap.pools.find((p) => p.id === filter);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {pool ? <PoolKpis pool={pool} t={t} /> : <ClusterKpis snap={snap} t={t} />}
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

function PoolKpis({ pool, t }: { pool: Pool; t: TFn }) {
  const isGpu = pool.kind === "gpu";
  const g = pool.gpu;
  const used = isGpu && g ? g.used : pool.cores.alloc;
  const total = isGpu && g ? g.total : pool.cores.total;
  const free = isGpu && g ? g.free : pool.cores.free;
  const unit = isGpu ? t("unit.gpu") : t("unit.cores");
  const st = pool.nodes_state;
  return (
    <>
      <GaugeKpi label={poolLabel(t, pool.id)} util={pool.util} value={nf(used)}
        hint={`${t("kpi.of")} ${nf(total)} ${unit}`} />
      <SplitCard label={t("part.available")} stats={[
        [free, unit, "text-ok-fg"],
        [
          isGpu ? pool.available_nodes : pool.idle_nodes,
          isGpu ? t("kpi.gpuNodesWithFree") : t("kpi.nodes"),
          "text-muted-foreground",
        ],
      ]} />
      <SplitCard label={t("kpi.nodes")} stats={[
        [(st.idle ?? 0) + (st.mixed ?? 0), t("kpi.schedulable"), "text-ok-fg"],
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
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-5">
        <ProgressCircle value={Math.round(util * 100)} radius={32} strokeWidth={6} color={toneTremor[utilTone(util)]}>
          <span className="tnum text-xs font-semibold">{pct(util)}</span>
        </ProgressCircle>
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
