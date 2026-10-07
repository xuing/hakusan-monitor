import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { useLive } from "@/hooks/live-context";
import { useResourceFilter } from "@/hooks/resource-filter-context";
import { poolTitle, useT, type TFn } from "@/i18n";
import { nodeIsSchedulable, parseGpuCount, unschedulableCores } from "@/lib/derive";
import { nf, pct } from "@/lib/format";
import { poolGpuAvailability } from "@/lib/gpu-fit";
import { utilTone } from "@/lib/slurm";
import type { Pool, Snapshot } from "@/types/snapshot";

export function KpiCards() {
  const { snap } = useLive();
  const { filter } = useResourceFilter();
  const t = useT();
  if (!snap) return null;
  // the whole cluster has no row of its own: every figure it held (nodes,
  // free nodes, queue) is on the pool cards, the queue card and the
  // nodes-needing-attention card; a pool in focus keeps its summary
  const pool = filter === "all" ? null : snap.pools.find((p) => p.id === filter);
  if (!pool) return null;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <PoolKpis pool={pool} snap={snap} t={t} />
    </div>
  );
}

function PoolKpis({ pool, snap, t }: { pool: Pool; snap: Snapshot; t: TFn }) {
  const isGpu = pool.kind === "gpu";
  const g = pool.gpu;
  const used = isGpu && g ? g.used : pool.cores.alloc;
  // capacity in service: a GPU or core on a down / drained node cannot be
  // had — H100 80GB with one card in maintenance is 3 / 3, full, not 3 / 4.
  // Reserved (PLANNED) capacity is in service: idle, held for a queued job.
  const held = isGpu ? { down: g?.down ?? 0, reserved: g?.reserved ?? 0 } : unschedulableCores(snap.nodes, pool.id);
  const offline = held.down;
  const total = Math.max(0, (isGpu && g ? g.total : pool.cores.total) - offline);
  const util = total > 0 ? used / total : pool.util;
  // "可用" GPUs = what the pool card calls ready (shared verdict), not every
  // idle card — queue-claimed or resource-short ones are not available.
  const free = isGpu && g ? poolGpuAvailability(snap, pool).ready : pool.cores.free;
  // nodes a new job can actually land on: in service, not held by the
  // scheduler, and with a free GPU (GPU pools) or a free core — a GPU node
  // with spare cores but every card taken does not count
  const withRoom = snap.nodes.filter((n) => {
    if (n.pool !== pool.id || !nodeIsSchedulable(n)) return false;
    if (isGpu && g) return parseGpuCount(n.gres, g.type) - parseGpuCount(n.gres_used, g.type) > 0;
    return n.cpus - n.alloc_cpus > 0;
  }).length;
  const unit = isGpu ? t("unit.gpu") : t("unit.cores");
  return (
    <>
      <GaugeKpi label={poolTitle(t, pool)} util={util} value={nf(used)}
        hint={[
          `${t("kpi.of")} ${nf(total)} ${unit}`,
          held.reserved > 0 && t(isGpu ? "kpi.reservedGpu" : "kpi.reservedCores", { n: nf(held.reserved) }),
          offline > 0 && t(isGpu ? "kpi.offlineGpu" : "kpi.offlineCores", { n: nf(offline) }),
        ].filter((part): part is string => Boolean(part))} />
      <SplitCard label={t("part.available")} stats={[
        [free, unit, "text-ok-fg"],
        [
          isGpu ? pool.available_nodes : pool.idle_nodes,
          t("kpi.nodes"),
          "text-muted-foreground",
        ],
      ]} />
      <SplitCard label={t("kpi.nodes")} stats={[
        [withRoom, t("kpi.withRoom"), "text-ok-fg"],
        [pool.down_nodes, t("kpi.down"), "text-muted-foreground"],
        [pool.nodes, t("kpi.total"), "text-muted-foreground"],
      ]} />
      <SplitCard label={t("kpi.queue")} stats={[
        [pool.queue.running, t("kpi.running"), "text-ok-fg"],
        [pool.queue.pending, t("kpi.pending"), "text-warn-fg"],
      ]} />
    </>
  );
}

function GaugeKpi({ label, util, value, hint }: { label: string; util: number; value: string; hint: string[] }) {
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
          {/* each part wraps whole: "364 核已预留" never splits */}
          <div className="flex flex-wrap gap-x-1.5 text-xs leading-snug text-muted-foreground">
            {hint.map((part, i) => (
              <span key={part} className="whitespace-nowrap">{i > 0 ? `· ${part}` : part}</span>
            ))}
          </div>
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
