import type { ReactNode } from "react";
import { useLive } from "@/hooks/live-context";
import { useResourceFilter } from "@/hooks/resource-filter-context";
import { poolLabel, useT } from "@/i18n";
import { poolCapacity } from "@/lib/derive";
import { schedulableGpuSlots } from "@/lib/gpu-fit";
import { partitionCap } from "@/lib/slurm";
import { cn } from "@/lib/utils";
import type { Pool, Snapshot } from "@/types/snapshot";

/** "All / GPU group / CPU group" — one chip per hardware pool. */
export function ResourceFilterChips() {
  const { snap } = useLive();
  const { filter, setFilter } = useResourceFilter();
  const t = useT();
  if (!snap) return null;

  const options = snap.pools
    .map((p, i) => ({ pool: p, i }))
    .sort((a, b) => Number(!hasAvailableNodes(a.pool)) - Number(!hasAvailableNodes(b.pool)) || a.i - b.i);
  const gpu = options.filter(({ pool }) => pool.kind === "gpu");
  const cpu = options.filter(({ pool }) => pool.kind === "cpu");

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => setFilter("all")}
        aria-pressed={filter === "all"}
        className={cn(
          "inline-flex h-8 items-center rounded-md border px-3 text-xs shadow-sm transition-colors",
          filter === "all"
            ? "border-primary bg-primary/15 font-medium text-foreground"
            : "border-border bg-background text-muted-foreground hover:border-primary/60 hover:bg-accent hover:text-foreground",
        )}
      >
        {t("filter.all")}
      </button>
      <FilterGroup label={t("kpi.gpu")}>
        {gpu.map(({ pool }) => (
          <FilterButton
            key={pool.id}
            pool={pool}
            active={filter === pool.id}
            label={poolLabel(t, pool.id)}
            onClick={() => setFilter(pool.id)}
            gpuSchedulable={gpuPoolSchedulableMax(snap, pool)}
          />
        ))}
      </FilterGroup>
      <FilterGroup label={t("kpi.cpu")}>
        {cpu.map(({ pool }) => (
          <FilterButton
            key={pool.id}
            pool={pool}
            active={filter === pool.id}
            label={poolLabel(t, pool.id)}
            onClick={() => setFilter(pool.id)}
            cpuFreeCores={poolCapacity(snap, pool.id).freeCores}
          />
        ))}
      </FilterGroup>
    </div>
  );
}

function FilterGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/20 px-2 py-1 shadow-sm">
      <span className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-1">{children}</div>
    </div>
  );
}

function FilterButton({
  pool,
  active,
  label,
  onClick,
  gpuSchedulable,
  cpuFreeCores,
}: {
  pool: Pool;
  active: boolean;
  label: string;
  onClick: () => void;
  /** GPU pools only: the best any single partition could grant right now —
   *  same "one grantable policy = green" rule as the Partitions page. */
  gpuSchedulable?: number;
  /** CPU pools only: idle cores scattered on non-fully-idle nodes. */
  cpuFreeCores?: number;
}) {
  const maint = !!pool.gpu?.maint;
  // GPU: green only if some partition can actually hand out a card now;
  // physically-idle-but-stranded (every policy blocked) reads amber, not
  // green — matches the hero number / pool bar on the Partitions page.
  // CPU: unchanged, plain idle-node availability.
  const dot = maint
    ? "bg-muted-foreground/45"
    : pool.kind === "gpu"
      ? (gpuSchedulable ?? 0) > 0
        ? "bg-ok"
        : (pool.gpu?.free ?? 0) > 0 || (pool.gpu?.reserved ?? 0) > 0
          // scheduler-reserved idle cards are still reachable via the
          // backfill window — "nothing here" (red) would contradict the
          // gap-shell tip shown two clicks away
          ? "bg-warn"
          : "bg-bad"
      : (pool.idle_nodes ?? 0) > 0
        ? "bg-ok" // a WHOLE idle node — any policy can start now
        : (cpuFreeCores ?? 0) > 0
          ? "bg-warn" // cores free, but scattered — some requests fit, most queue
          : "bg-bad"; // literally nothing free — every request queues
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs shadow-sm transition-colors",
        active
          ? "border-primary bg-primary/15 font-medium text-foreground"
          : maint
            ? "border-border border-dashed bg-background/60 text-muted-foreground hover:bg-background hover:text-foreground"
            : "border-border bg-background text-muted-foreground hover:border-primary/60 hover:bg-accent hover:text-foreground",
      )}
    >
      <span className={cn("h-2 w-2 rounded-full", dot)} aria-hidden />
      {label}
    </button>
  );
}

function hasAvailableNodes(pool: Pool) {
  return (pool.available_nodes ?? pool.idle_nodes ?? 0) > 0;
}

function gpuPoolSchedulableMax(snap: Snapshot, pool: Pool): number {
  if (pool.kind !== "gpu") return 0;
  const parts = snap.partitions.filter((p) => p.pool === pool.id);
  return Math.max(0, ...parts.map((p) => schedulableGpuSlots(snap.nodes, pool, partitionCap(p.name, snap.policy))));
}
