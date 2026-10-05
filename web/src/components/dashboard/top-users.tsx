import { Empty } from "@/components/common/empty";
import { SectionCard } from "@/components/common/section-card";
import { useLive } from "@/hooks/live-context";
import { useResourceFilter } from "@/hooks/resource-filter-context";
import { poolLabel, useT, type TFn } from "@/i18n";
import { fmtMB, nf } from "@/lib/format";
import {
  amountOf,
  fmtShare,
  poolUsage,
  shareOf,
  topUsers,
  usageByPool,
  type PoolUsage,
  type Resource,
  type UsageTail,
  type UserUsage,
} from "@/lib/user-usage";
import { cn } from "@/lib/utils";

/** Rows per pool: five on the overview grid, ten when one pool is in focus. */
const ROWS_ALL = 5;
const ROWS_FOCUSED = 10;

/** One panel per hardware pool, each ranking its users by the share of that
 *  pool they hold in their dominant resource (GPUs, cores or memory). A GPU
 *  and a CPU user never share a bar, and the bar's denominator is the pool's
 *  own total, stated in the panel header. */
export function TopUsers() {
  const { snap } = useLive();
  const { filter } = useResourceFilter();
  const t = useT();
  if (!snap) return null;

  const focused = filter !== "all";
  const pools = focused
    ? [poolUsage(snap, filter)].filter((u): u is PoolUsage => !!u && u.users.length > 0)
    : usageByPool(snap);
  const limit = focused ? ROWS_FOCUSED : ROWS_ALL;
  const panels = pools.map((usage) => ({ usage, ...topUsers(usage, limit) }));
  const anyQueued = panels.some((p) => p.shown.some((u) => u.pending > 0));

  return (
    <SectionCard title={t("section.topusers")} extra={anyQueued ? <Legend t={t} /> : undefined}>
      {panels.length === 0 ? (
        <Empty>{t("users.none")}</Empty>
      ) : (
        <div className={cn(!focused && "grid gap-x-6 gap-y-5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4")}>
          {panels.map(({ usage, shown, rest }) => (
            <PoolPanel key={usage.pool.id} usage={usage} shown={shown} rest={rest} wide={focused} t={t} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function Legend({ t }: { t: TFn }) {
  return (
    <span className="flex items-center gap-3 whitespace-nowrap">
      <span className="flex items-center gap-1.5">
        <span className="h-1 w-3 rounded-full bg-info" />
        {t("users.held")}
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-1 w-3 rounded-full bg-warn/45" />
        {t("users.queued")}
      </span>
    </span>
  );
}

function PoolPanel({
  usage,
  shown,
  rest,
  wide,
  t,
}: {
  usage: PoolUsage;
  shown: UserUsage[];
  rest: UsageTail | null;
  /** the card is one pool wide: lay the rows out in two columns */
  wide: boolean;
  t: TFn;
}) {
  const { pool, totals, unit, pendingJobs } = usage;
  return (
    <section className="min-w-0">
      <header className="flex items-baseline justify-between gap-3 border-b border-border pb-1.5 text-xs">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate font-medium text-foreground">{poolLabel(t, pool.id)}</span>
          <span className="tnum whitespace-nowrap text-muted-foreground">{amountLabel(unit, totals[unit], t)}</span>
        </div>
        {pendingJobs > 0 && (
          <span className="whitespace-nowrap text-muted-foreground">
            <b className="text-warn-fg">{nf(pendingJobs)}</b> {t("queue.pending")}
          </span>
        )}
      </header>
      <div className={cn("mt-2", wide ? "grid gap-x-8 gap-y-2.5 md:grid-cols-2" : "space-y-2.5")}>
        {shown.map((u) => (
          <UserRow key={u.user} u={u} usage={usage} t={t} />
        ))}
        {rest && <TailRow rest={rest} usage={usage} t={t} />}
      </div>
    </section>
  );
}

function UserRow({ u, usage, t }: { u: UserUsage; usage: PoolUsage; t: TFn }) {
  const held = u.shares[u.dominant];
  const queued = shareOf(usage.totals, u.dominant, amountOf(u.queued, u.dominant));
  return (
    <div title={sharesTitle(u, usage, t)}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-mono text-xs font-medium text-info-fg">{u.user}</span>
        <span className="tnum shrink-0 whitespace-nowrap font-mono text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{amountLabel(u.dominant, amountOf(u.held, u.dominant), t)}</span>{" "}
          {fmtShare(held)}
        </span>
      </div>
      <ShareBar held={held} queued={queued} />
      <Details parts={details(u, usage, t)} />
    </div>
  );
}

/** Facts in one line; on a phone it wraps between facts, never inside one. */
function Details({ parts }: { parts: string[] }) {
  return (
    <div className="mt-1 flex flex-wrap gap-x-1.5 text-xs text-muted-foreground">
      {parts.map((p, i) => (
        <span key={`${i}-${p}`} className="whitespace-nowrap">
          {i > 0 && "· "}
          {p}
        </span>
      ))}
    </div>
  );
}

/** Everyone past the shown rows, as one line: how much of the pool the
 *  long tail holds together. Gray — it is not a user. */
function TailRow({ rest, usage, t }: { rest: UsageTail; usage: PoolUsage; t: TFn }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          {rest.users === 1 ? t("users.other1") : t("users.others", { n: nf(rest.users) })}
        </span>
        <span className="tnum shrink-0 whitespace-nowrap font-mono">
          {amountLabel(usage.unit, rest.units, t)} {fmtShare(rest.share)}
        </span>
      </div>
      <ShareBar held={rest.share} queued={0} tone="neutral" />
      <Details parts={[jobsLabel(rest.running, t)]} />
    </div>
  );
}

/** Held share in blue, queued demand in the amber every "will queue" zone
 *  on this page uses; both clamp to the track so a user asking for more than
 *  the pool has still ends at 100%. */
function ShareBar({ held, queued, tone = "info" }: { held: number; queued: number; tone?: "info" | "neutral" }) {
  const h = Math.min(1, Math.max(0, held));
  const q = Math.min(1 - h, Math.max(0, queued));
  return (
    <div className="mt-1 flex h-1 gap-0.5 overflow-hidden rounded-full bg-muted">
      <span
        className={cn("h-full rounded-full transition-all duration-500", tone === "info" ? "bg-info" : "bg-muted-foreground")}
        style={{ width: `${h * 100}%`, minWidth: h > 0 ? 2 : 0 }}
      />
      {q > 0 && (
        <span className="h-full rounded-full bg-warn/45 transition-all duration-500" style={{ width: `${q * 100}%`, minWidth: 2 }} />
      )}
    </div>
  );
}

const RESOURCES: Resource[] = ["gpus", "cores", "mem"];

function amountLabel(r: Resource, n: number, t: TFn): string {
  if (r === "mem") return fmtMB(n);
  return `${nf(n)} ${t(r === "gpus" ? "unit.gpu" : "unit.cores")}`;
}

const jobsLabel = (n: number, t: TFn) => (n === 1 ? t("users.job1") : t("users.jobs", { n: nf(n) }));

/** Jobs, then the resources the headline number leaves out, then what the
 *  user's waiting jobs ask for in the headline unit. */
function details(u: UserUsage, usage: PoolUsage, t: TFn): string[] {
  const parts = [jobsLabel(u.running, t)];
  for (const r of RESOURCES) {
    const n = amountOf(u.held, r);
    if (r !== u.dominant && n > 0) parts.push(amountLabel(r, n, t));
  }
  if (u.pending > 0) {
    const r: Resource = amountOf(u.queued, u.dominant) > 0 ? u.dominant : usage.unit;
    const n = amountOf(u.queued, r);
    parts.push(n > 0 ? t("users.queuedUnits", { n: nf(u.pending), units: amountLabel(r, n, t) }) : t("users.queuedJobs", { n: nf(u.pending) }));
  }
  return parts;
}

/** Hover: the user's share in every resource, which is how the headline one was picked. */
function sharesTitle(u: UserUsage, usage: PoolUsage, t: TFn): string {
  const parts: string[] = [];
  if (usage.totals.gpus > 0) parts.push(`${t("unit.gpu")} ${fmtShare(u.shares.gpus)}`);
  parts.push(`${t("unit.cores")} ${fmtShare(u.shares.cores)}`, `${t("kpi.memory")} ${fmtShare(u.shares.mem)}`);
  return parts.join(" · ");
}
