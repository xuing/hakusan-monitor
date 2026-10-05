import { Empty } from "@/components/common/empty";
import { OccupancyMap, type OccupancyTile } from "@/components/common/occupancy-map";
import { SectionCard } from "@/components/common/section-card";
import { useLive } from "@/hooks/live-context";
import { useResourceFilter } from "@/hooks/resource-filter-context";
import { coresText, poolTitle, useT, type TFn } from "@/i18n";
import { fmtMB, nf } from "@/lib/format";
import { occupancyMode } from "@/lib/occupancy-mode";
import { groupUsage, poolUsage, type PoolUsage } from "@/lib/user-usage";
import { cn } from "@/lib/utils";
import type { Snapshot } from "@/types/snapshot";

/** Who holds the cluster: on the overview one map for every GPU pool and one
 *  for every CPU pool, for the pool in focus that pool alone. Each user's
 *  tile is the GPUs (or cores) they hold; free and offline capacity fill the
 *  rest; cores, memory and jobs come up on hover. */
export function TopUsers() {
  const { snap } = useLive();
  const { filter } = useResourceFilter();
  const t = useT();
  if (!snap) return null;

  const focused = filter !== "all";
  const panels = (focused ? [poolUsage(snap, filter)] : [groupUsage(snap, "gpu"), groupUsage(snap, "cpu")])
    .filter((u): u is PoolUsage => !!u && u.users.length > 0);

  return (
    <SectionCard title={t("section.topusers")} extra={panels.length ? <Legend t={t} /> : undefined}>
      {panels.length === 0 ? (
        <Empty>{t("users.none")}</Empty>
      ) : (
        // columns follow the card's own width, wherever the page puts it
        <div className="@container">
          <div className={cn("grid gap-x-8 gap-y-5", panels.length > 1 && "@2xl:grid-cols-2")}>
            {panels.map((usage) => (
              <PoolPanel key={usage.id} usage={usage} snap={snap} t={t} />
            ))}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function Legend({ t }: { t: TFn }) {
  const item = (cls: string, label: string) => (
    <span className="flex items-center gap-1.5">
      <span className={cn("h-2.5 w-2.5 rounded-sm", cls)} />
      {label}
    </span>
  );
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 whitespace-nowrap">
      {item("bg-[var(--blue-4)] ring-1 ring-inset ring-[var(--blue-7)]", t("users.held"))}
      {item("bg-[var(--green-4)] ring-1 ring-inset ring-[var(--green-7)]", t("users.free"))}
      {item("bg-[var(--gray-4)] ring-1 ring-inset ring-[var(--gray-7)]", t("users.offline"))}
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full bg-warn" />
        {t("users.queued")}
      </span>
    </span>
  );
}

function PoolPanel({ usage, snap, t }: { usage: PoolUsage; snap: Snapshot; t: TFn }) {
  const { pools, totals, unit, pendingJobs } = usage;
  const single = pools.length === 1 ? pools[0] : null;
  const title = single ? poolTitle(t, single) : t(usage.id === "gpu" ? "users.gpuGroup" : "users.cpuGroup");
  return (
    <section className="min-w-0">
      <header className="mb-2 flex items-baseline justify-between gap-3 text-xs">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-medium text-foreground">{title}</span>
          <span className="tnum whitespace-nowrap text-muted-foreground">{unitText(unit, totals[unit], t)}</span>
        </div>
        {pendingJobs > 0 && (
          <span className="whitespace-nowrap text-muted-foreground">
            <span aria-hidden className="mr-1.5 inline-block h-2 w-2 rounded-full bg-warn/45" />
            <b className="tnum text-foreground">{nf(pendingJobs)}</b> {t("queue.pending")}
          </span>
        )}
      </header>
      <OccupancyMap
        tiles={usageTiles(usage, t)}
        ariaLabel={title}
        restLabel={(k, amount) => ({ label: t("users.others", { n: k }), amount: unitText(unit, amount, t) })}
        nodeWord={t("spec.nodes")}
        // a pool in focus is drawn the way its own card draws it, kept short
        {...(single ? occupancyMode(single, snap) : {})}
        className={single ? "max-h-72" : "aspect-[4/3]"}
      />
    </section>
  );
}

const unitText = (unit: "gpus" | "cores", n: number, t: TFn) =>
  unit === "gpus" ? `${nf(n)} ${t("unit.gpu")}` : coresText(t, n);

/** One tile per user, sized in the panel's unit, then free and offline. */
function usageTiles(usage: PoolUsage, t: TFn): OccupancyTile[] {
  const { unit, pools } = usage;
  const users: OccupancyTile[] = usage.users
    .map((u) => {
      const value = unit === "gpus" ? u.held.gpus : u.held.cores;
      // a group spans GPU models: "6 A40 · 2 A100"
      const models = pools.length > 1
        ? Object.entries(u.gpusByPool).sort((a, b) => b[1] - a[1])
          .map(([id, n]) => `${nf(n)} ${pools.find((p) => p.id === id)?.gpu?.label ?? id}`).join(" · ")
        : "";
      return {
        key: u.user,
        value,
        kind: "user" as const,
        label: u.user,
        amount: unitText(unit, value, t),
        queued: u.pending > 0,
        details: [
          t(u.running === 1 ? "users.job1" : "users.jobs", { n: u.running }),
          ...(models ? [models] : []),
          [unit === "gpus" ? coresText(t, u.held.cores) : "", `${t("kpi.memory")} ${fmtMB(u.held.memMb)}`].filter(Boolean).join(" · "),
          ...(u.pending ? [t("users.queuedJobs", { n: u.pending })] : []),
        ],
      };
    })
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value);
  let free = 0;
  let off = 0;
  for (const p of pools) {
    if (unit === "gpus" && p.gpu) {
      free += p.gpu.free;
      off += p.gpu.down + (p.gpu.reserved ?? 0);
    } else {
      free += p.cores.free;
      off += p.cores.unavailable ?? 0;
    }
  }
  return [
    ...users,
    { key: "~free", value: free, kind: "free", amount: unitText(unit, free, t), sub: t("users.free"), details: [t("users.free")] },
    { key: "~off", value: off, kind: "off", amount: unitText(unit, off, t), sub: t("users.offline"), details: [t("users.offline")] },
  ];
}
