import type { ReactNode } from "react";
import { useLive } from "@/hooks/live-context";
import { useResourceFilter } from "@/hooks/resource-filter-context";
import { POOL_DOT } from "@/components/common/pool-tone";
import { poolTitle, useT } from "@/i18n";
import { poolTone, type PoolTone } from "@/lib/pool-status";
import { cn } from "@/lib/utils";

/** "All / GPU group / CPU group" — one chip per hardware pool. The caption
 *  rides inside the same wrapping row so it stays level with the first line
 *  of chips when the groups wrap. */
export function ResourceFilterChips({ label }: { label?: string }) {
  const { snap } = useLive();
  const { filter, setFilter } = useResourceFilter();
  const t = useT();
  if (!snap) return null;

  const options = snap.pools
    .map((p, i) => ({ pool: p, i, tone: poolTone(snap, p) }))
    .sort((a, b) => Number(a.tone !== "ok") - Number(b.tone !== "ok") || a.i - b.i);
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
        {gpu.map(({ pool, tone }) => (
          <FilterButton key={pool.id} tone={tone} active={filter === pool.id} label={poolTitle(t, pool)} onClick={() => setFilter(pool.id)} />
        ))}
      </FilterGroup>
      <FilterGroup label={t("kpi.cpu")}>
        {cpu.map(({ pool, tone }) => (
          <FilterButton key={pool.id} tone={tone} active={filter === pool.id} label={poolTitle(t, pool)} onClick={() => setFilter(pool.id)} />
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
  tone,
  active,
  label,
  onClick,
}: {
  /** the pool's verdict (lib/pool-status) — the same its card and group header show */
  tone: PoolTone;
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  const maint = tone === "off";
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
      <span className={cn("h-2 w-2 rounded-full", POOL_DOT[tone])} aria-hidden />
      {label}
    </button>
  );
}
