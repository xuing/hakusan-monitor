import type { ReactNode } from "react";
import { useLive } from "@/hooks/live-context";
import { useResourceFilter } from "@/hooks/resource-filter-context";
import { poolTitle, useT } from "@/i18n";
import { poolCapacity } from "@/lib/derive";
import { poolGpuAvailability } from "@/lib/gpu-fit";
import type { GpuAvailability } from "@/lib/gpu-availability";
import { cn } from "@/lib/utils";
import type { Pool } from "@/types/snapshot";

/** "All / GPU group / CPU group" — one chip per hardware pool. The caption
 *  rides inside the same wrapping row so it stays level with the first line
 *  of chips when the groups wrap. */
export function ResourceFilterChips({ label }: { label?: string }) {
  const { snap } = useLive();
  const { filter, setFilter } = useResourceFilter();
  const t = useT();
  if (!snap) return null;

  const options = snap.pools
    .map((p, i) => ({ pool: p, i, gpuAvail: p.kind === "gpu" ? poolGpuAvailability(snap, p) : undefined }))
    .sort((a, b) => Number(!hasAvailable(a)) - Number(!hasAvailable(b)) || a.i - b.i);
  const gpu = options.filter(({ pool }) => pool.kind === "gpu");
  const cpu = options.filter(({ pool }) => pool.kind === "cpu");

  return (
    // phones: one scrollable line, so the sticky bar stays ~40px instead of
    // stacking three rows of chips over the content it filters
    <div className="subtle-scroll -mx-4 flex items-center gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
      {label && <span className="hidden text-xs text-muted-foreground sm:inline">{label}</span>}
      <button
        type="button"
        onClick={() => setFilter("all")}
        aria-pressed={filter === "all"}
        className={cn(
          "inline-flex shrink-0 items-center self-stretch rounded-md border px-3 text-xs shadow-sm transition-colors",
          filter === "all"
            ? "border-primary bg-primary/15 font-medium text-foreground"
            : "border-border bg-background text-muted-foreground hover:border-primary/60 hover:bg-accent hover:text-foreground",
        )}
      >
        {t("filter.all")}
      </button>
      <FilterGroup label={t("kpi.gpu")}>
        {gpu.map(({ pool, gpuAvail }) => (
          <FilterButton
            key={pool.id}
            pool={pool}
            active={filter === pool.id}
            label={poolTitle(t, pool)}
            onClick={() => setFilter(pool.id)}
            gpuAvail={gpuAvail}
          />
        ))}
      </FilterGroup>
      <FilterGroup label={t("kpi.cpu")}>
        {cpu.map(({ pool }) => (
          <FilterButton
            key={pool.id}
            pool={pool}
            active={filter === pool.id}
            label={poolTitle(t, pool)}
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
    <div className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-muted/20 px-2 py-1 shadow-sm">
      <span className="whitespace-nowrap px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1 sm:flex-wrap">{children}</div>
    </div>
  );
}

function FilterButton({
  pool,
  active,
  label,
  onClick,
  gpuAvail,
  cpuFreeCores,
}: {
  pool: Pool;
  active: boolean;
  label: string;
  onClick: () => void;
  /** GPU pools only: the shared pool verdict (poolGpuAvailability) — the
   *  same one the pool card and Partitions page colour themselves by. */
  gpuAvail?: GpuAvailability;
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
      ? (gpuAvail?.ready ?? 0) > 0
        ? "bg-ok"
        : (gpuAvail?.segments ?? []).some((s) => s.kind !== "down" && s.kind !== "full")
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
        "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-xs shadow-sm transition-colors",
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

function hasAvailable({ pool, gpuAvail }: { pool: Pool; gpuAvail?: GpuAvailability }) {
  if (gpuAvail) return gpuAvail.ready > 0;
  return (pool.available_nodes ?? pool.idle_nodes ?? 0) > 0;
}

