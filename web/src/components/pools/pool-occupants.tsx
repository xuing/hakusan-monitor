// Who is using a pool: per job (time left) or per user (an occupancy map).
import { useEffect, useState } from "react";
import { Clock, LayoutGrid, X } from "lucide-react";
import { OccupancyMap, type OccupancyTile } from "@/components/common/occupancy-map";
import { Segmented } from "@/components/common/segmented";
import { jobSizeText } from "@/components/common/verdict-text";
import { useLive } from "@/hooks/live-context";
import { coresText, type TFn } from "@/i18n";
import { expandHostlist, gpuNodeParts, occupantsForPool, unschedulableCores } from "@/lib/derive";
import { fmtCountdown, fmtDur, fmtMB, nf, parseDur } from "@/lib/format";
import { occupancyMode } from "@/lib/occupancy-mode";
import { idleGpuTiles, userNodeParts } from "@/lib/occupancy-tiles";
import { poolWaiters } from "@/lib/queue";
import { partitionCap, wallLabelSec } from "@/lib/slurm";
import { cn } from "@/lib/utils";
import type { Occupant, Pool, Snapshot } from "@/types/snapshot";

export function Occupants({ pool, t }: { pool: Pool; t: TFn }) {
  const { snap } = useLive();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"usage" | "ending">("ending");
  const [now, setNow] = useState(() => Date.now() / 1000); // ticks the live countdown
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);
  if (!snap) return null;

  const isGpu = pool.kind === "gpu";
  const all = occupantsForPool(snap, pool.id); // pre-sorted by resource usage
  const needle = q.trim().toLowerCase();
  // a whole user name (typed, or set by clicking their block) means that
  // user alone: "ann" must not bring in "joann" or a node named "ann-01"
  const exactUser = !!needle && all.some((o) => o.user.toLowerCase() === needle);
  const filtered = needle
    ? all.filter((o) => (exactUser
      ? o.user.toLowerCase() === needle
      : o.user.toLowerCase().includes(needle) || o.nodelist.toLowerCase().includes(needle)))
    : all;
  let list = filtered;
  if (sort === "ending") {
    list = [...list].sort((a, b) => (a.end_time || "~").localeCompare(b.end_time || "~"));
  }
  const groupByUser = sort === "usage";
  const userGroups = groupByUser ? occupantUserGroups(filtered) : [];
  const totalUsers = occupantUserGroups(all).length;
  const shown = groupByUser ? userGroups.length : list.length;
  const total = groupByUser ? totalUsers : all.length;
  const count = (n: number) => <span className="tnum font-normal text-muted-foreground">{n}</span>;
  // One shared ruler for every row in this pool — the longest wall-time cap among the
  // partitions sharing this hardware. Otherwise a job that maxes out its own (shorter)
  // partition policy looks "full" even though a sibling partition allows much longer.
  const poolCapSeconds = Math.max(0, ...pool.partitions.map((p) => partitionWallSeconds(p, snap.policy)));
  return (
    <div className="mt-2">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {/* two views, not two sorts: the jobs (when GPUs free up) or the
            users (who holds how much), each with its count */}
        <Segmented
          value={sort}
          onChange={setSort}
          ariaLabel={t("pool.occupants")}
          className="h-8"
          itemClassName="inline-flex items-center gap-1.5 px-3"
          options={[
            { value: "ending", label: <><Clock aria-hidden className="size-3.5" />{t("pool.viewJobs")}{count(all.length)}</> },
            { value: "usage", label: <><LayoutGrid aria-hidden className="size-3.5" />{t("pool.viewUsers")}{count(totalUsers)}</> },
          ]}
        />
        <div className="relative min-w-32 flex-1">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("table.search")}
            aria-label={t("table.search")}
            className={cn("h-8 w-full rounded-md border border-border bg-background ps-2 text-xs outline-none focus:border-primary", needle ? "pe-20" : "pe-2")}
          />
          {/* the count only while a search narrows the view: the tabs carry the totals */}
          {needle && (
            <div className="absolute inset-y-0 end-1 flex items-center gap-1">
              <span className="tnum text-xs text-muted-foreground">{shown}/{total}</span>
              <button
                type="button"
                onClick={() => setQ("")}
                aria-label={t("table.clear")}
                className="rounded p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/45"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </div>
          )}
        </div>
      </div>
      {/* by usage: the pool as one map, each user's tile its share; a search
          narrows it to a list of the matching users */}
      {groupByUser && !needle ? (
        <OccupancyMap
          tiles={poolOccupancyTiles(pool, snap, userGroups, t)}
          ariaLabel={t("pool.viewUsers")}
          // a user's block opens their jobs, soonest ending first
          onPick={(tile) => {
            setSort("ending");
            setQ(tile.label ?? "");
          }}
          restLabel={(k, amount) => ({ label: t("users.others", { n: k }), amount: isGpu ? `${nf(amount)} ${t("unit.gpu")}` : coresText(t, amount) })}
          nodeWord={t("spec.nodes")}
          multiLabel={t("users.multiGpu")}
          {...occupancyMode(pool, snap)}
        />
      ) : (
      <div className="max-h-72 space-y-1 overflow-y-auto pe-1">
        {groupByUser ? (
          userGroups.map((group) => (
            <OccupantUserRow key={group.user} group={group} isGpu={isGpu} t={t} />
          ))
        ) : (
          list.map((o) => (
            <OccupantRow key={String(o.job_id)} o={o} now={now} generatedAt={snap.generated_at} poolCap={poolCapSeconds} t={t} />
          ))
        )}
        {shown === 0 && (
          <div className="py-3 text-center text-xs text-muted-foreground">{t("table.noresults")}</div>
        )}
      </div>
      )}
    </div>
  );
}

/** Tiles for a pool's occupancy map: one per user (GPUs on a GPU pool,
 *  cores otherwise), then what is free and what is offline. */
function poolOccupancyTiles(pool: Pool, snap: Snapshot, groups: OccupantUserGroup[], t: TFn): OccupancyTile[] {
  const isGpu = pool.kind === "gpu" && !!pool.gpu;
  const unit = (n: number) => (isGpu ? `${nf(n)} ${t("unit.gpu")}` : coresText(t, n));
  const waiting = new Map<string, number>();
  for (const { job } of poolWaiters(snap, pool.id)) {
    waiting.set(job.user_name, (waiting.get(job.user_name) ?? 0) + 1);
  }
  const perNode = isGpu ? gpuNodeParts(snap, pool.id) : null;
  const users: OccupancyTile[] = groups
    .map((g) => {
      const value = isGpu ? g.gpus : g.cpus;
      const queued = waiting.get(g.user) ?? 0;
      return {
        key: g.user,
        value,
        kind: "user" as const,
        label: g.user,
        amount: unit(value),
        sub: `${g.nodes} ${t("spec.nodes")}`,
        // the row layout prints one line: who, how much, how many nodes
        queued: queued > 0,
        parts: userNodeParts(perNode?.get(g.user), value, t),
        queuedText: queued ? t("users.queuedJobs", { n: queued }) : undefined,
        details: [
          `${g.nodes} ${t("spec.nodes")} · ${t(g.jobs === 1 ? "users.job1" : "users.jobs", { n: g.jobs })}`,
          [isGpu ? coresText(t, g.cpus) : "", `${t("kpi.memory")} ${fmtMB(g.mem_mb)}`].filter(Boolean).join(" · "),
        ],
      };
    })
    .sort((a, b) => b.value - a.value);
  const free = isGpu ? pool.gpu!.free : pool.cores.free;
  const held = isGpu ? { reserved: pool.gpu!.reserved ?? 0, down: pool.gpu!.down } : unschedulableCores(snap.nodes, pool.id);
  // GPUs: one tile per node, so two free GPUs read as one node's pair or
  // as two nodes' singles (the grid parts owners with a gap)
  const idle = isGpu ? idleGpuTiles(pool, snap, unit, t) : null;
  if (idle && idle.free === free && idle.reserved === held.reserved && idle.down === held.down) {
    return [...users, ...idle.tiles];
  }
  return [
    ...users,
    { key: "~free", value: free, kind: "free", amount: unit(free), sub: t("users.free"), details: [t("users.free")] },
    { key: "~reserved", value: held.reserved, kind: "reserved", amount: unit(held.reserved), sub: t("users.reserved"), details: [t("users.reservedDetail")] },
    { key: "~off", value: held.down, kind: "off", amount: unit(held.down), sub: t("users.offline"), details: [t("users.offline")] },
  ];
}

interface OccupantUserGroup {
  user: string;
  jobs: number;
  gpus: number;
  cpus: number;
  mem_mb: number;
  nodes: number;
}

function occupantUserGroups(list: Occupant[]): OccupantUserGroup[] {
  const map = new Map<string, OccupantUserGroup>();
  // two jobs on one node hold one node, not two
  const hosts = new Map<string, Set<string>>();
  for (const o of list) {
    const g = map.get(o.user) ?? {
      user: o.user,
      jobs: 0,
      gpus: 0,
      cpus: 0,
      mem_mb: 0,
      nodes: 0,
    };
    g.jobs += 1;
    g.gpus += o.gpus;
    g.cpus += o.cpus;
    g.mem_mb += o.mem_mb;
    const mine = hosts.get(o.user) ?? new Set<string>();
    hosts.set(o.user, mine);
    for (const h of expandHostlist(o.nodelist)) mine.add(h);
    g.nodes = mine.size || g.nodes + o.nodes;
    map.set(o.user, g);
  }
  return [...map.values()].sort(
    (a, b) =>
      b.gpus - a.gpus
      || b.cpus - a.cpus
      || b.mem_mb - a.mem_mb
      || b.jobs - a.jobs
      || a.user.localeCompare(b.user),
  );
}

function OccupantRow({
  o,
  now,
  generatedAt,
  poolCap,
  t,
}: {
  o: Occupant;
  now: number;
  generatedAt: number;
  poolCap: number;
  t: TFn;
}) {
  // live remaining = remaining-at-snapshot minus seconds elapsed since the snapshot
  const remaining = Math.max(0, parseDur(o.time_left) - (now - generatedAt));
  const requested = parseDur(o.time_limit);
  const cap = poolCap || requested;
  const remFrac = cap > 0 ? Math.min(1, remaining / cap) : 0;
  const requestedFrac = cap > 0 ? Math.min(1, requested / cap) : 0;
  // Short jobs in a long-cap partition (e.g. 12h in a 7d DEF slot) round to a sliver —
  // floor the *visible* width so they stay a readable bar instead of vanishing; the
  // color still reflects the true fraction, not the floored width.
  const barWidth = remFrac > 0 ? Math.max(3, remFrac * 100) : 0;
  // The bar means "how long this can still occupy resources, relative to what this
  // partition normally allows": short is good, long is expensive.
  const barColor = remFrac >= 0.5 ? "bg-bad" : remFrac >= 0.15 ? "bg-warn" : "bg-ok";
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-1.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-info-fg">{o.user}</span>
        <div className="flex items-center gap-2 font-mono text-muted-foreground">
          <span className="text-foreground">{jobSizeText(o, t)}</span>
          <span className="max-w-[8rem] truncate">{o.nodelist}</span>
        </div>
      </div>
      <div className="mt-1 flex items-center gap-2">
        {/* Track = this partition's policy wall-time cap. Three zones, left to right:
            colored = time left, grey = already spent (of this job's own request),
            bare track = headroom this job will never touch because it asked for less
            than the partition allows. */}
        <div dir="ltr" className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("absolute inset-y-0 start-0 transition-all duration-1000 ease-linear", barColor)}
            style={{ width: `${barWidth}%` }}
          />
          {requestedFrac * 100 > barWidth && (
            <div
              className="absolute inset-y-0 bg-muted-foreground/30 transition-all duration-1000 ease-linear"
              style={{ left: `${barWidth}%`, width: `${requestedFrac * 100 - barWidth}%` }}
            />
          )}
        </div>
        <span className="tnum shrink-0 font-mono text-xs">
          <span className="text-foreground">{fmtCountdown(remaining)}</span>
          {requested > 0 && <span className="text-muted-foreground"> / {fmtDur(requested)}</span>}
        </span>
      </div>
    </div>
  );
}

function OccupantUserRow({
  group,
  isGpu,
  t,
}: {
  group: OccupantUserGroup;
  isGpu: boolean;
  t: TFn;
}) {
  const primary = isGpu ? `${group.gpus} ${t("unit.gpu")}` : coresText(t, group.cpus);
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-1.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-info-fg">{group.user}</span>
        <span className="tnum rounded bg-info-soft px-1.5 py-0.5 font-mono text-xs font-semibold text-info-fg">
          {primary}
        </span>
      </div>
      <div className="mt-1 flex min-w-0 items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">
          {group.jobs} {t("topusers.jobs")}
          {/* the chip above has the headline; the line repeats it among the rest */}
          {isGpu && <> · {group.gpus} {t("unit.gpu")}</>}
          {isGpu && <> · {coresText(t, group.cpus)}</>} · {fmtMB(group.mem_mb)}
          {group.nodes > 0 && <> · {group.nodes} {t("spec.nodes")}</>}
        </span>
      </div>
    </div>
  );
}

function partitionWallSeconds(partition: string, policy?: Snapshot["policy"]) {
  const part = String(partition || "").split(",")[0];
  const wall = partitionCap(part, policy).wall;
  return wallLabelSec(wall);
}
