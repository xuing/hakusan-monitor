// Who is using a pool: the occupancy map (who holds how much), then the jobs
// that free resources first (time left), filtered by a search or a click.
import { useEffect, useState } from "react";
import { ChevronDown, Clock, X } from "lucide-react";
import { OccupancyMap, type OccupancyTile } from "@/components/common/occupancy-map";
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

/** Jobs listed before "all N": the few that free resources first. */
const PREVIEW = 3;

export function Occupants({ pool, t }: { pool: Pool; t: TFn }) {
  const { snap } = useLive();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
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
  // soonest ending first: when the pool's resources free up
  const list = [...filtered].sort((a, b) => (a.end_time || "~").localeCompare(b.end_time || "~"));
  // a search shows every match; otherwise the first few, unless one more
  // would be all of them
  const folded = !needle && !open && list.length > PREVIEW + 1;
  const rows = folded ? list.slice(0, PREVIEW) : list;
  // the users the filter leaves, for the map to keep in front
  const matched = new Set(filtered.map((o) => o.user));
  // One shared ruler for every row in this pool — the longest wall-time cap among the
  // partitions sharing this hardware. Otherwise a job that maxes out its own (shorter)
  // partition policy looks "full" even though a sibling partition allows much longer.
  const poolCapSeconds = Math.max(0, ...pool.partitions.map((p) => partitionWallSeconds(p, snap.policy)));
  return (
    <div className="mt-2 space-y-3">
      {/* who holds the pool: a click on a user's block shows their jobs below,
          a second click shows everyone again */}
      <OccupancyMap
        tiles={poolOccupancyTiles(pool, snap, occupantUserGroups(all), t)}
        ariaLabel={t("pool.viewUsers")}
        onPick={(tile) => setQ((prev) => (prev.trim().toLowerCase() === tile.label?.toLowerCase() ? "" : tile.label ?? ""))}
        highlight={needle ? (tile) => tile.kind === "user" && matched.has(tile.label ?? "") : undefined}
        restLabel={(k, amount) => ({ label: t("users.others", { n: k }), amount: isGpu ? `${nf(amount)} ${t("unit.gpu")}` : coresText(t, amount) })}
        nodeWord={t("spec.nodes")}
        multiLabel={t("users.multiGpu")}
        {...occupancyMode(pool, snap)}
      />
      <div>
        <div className="mb-1.5 flex flex-wrap items-center gap-2">
          <h4 className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
            <Clock aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{t("section.releases")}</span>
            <span className="tnum font-normal text-muted-foreground">{needle ? `${list.length}/${all.length}` : all.length}</span>
          </h4>
          <div className="relative ms-auto w-40 min-w-0">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("table.search")}
              aria-label={t("table.search")}
              className={cn("h-7 w-full rounded-md border border-border bg-background ps-2 text-xs outline-none focus:border-primary", needle ? "pe-7" : "pe-2")}
            />
            {needle && (
              <button
                type="button"
                onClick={() => setQ("")}
                aria-label={t("table.clear")}
                className="absolute inset-y-0 end-1 my-auto h-5 rounded p-0.5 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/45"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className={cn("space-y-1", !folded && list.length > PREVIEW + 1 && "max-h-72 overflow-y-auto pe-1")}>
          {rows.map((o) => (
            <OccupantRow key={String(o.job_id)} o={o} now={now} generatedAt={snap.generated_at} poolCap={poolCapSeconds} t={t} />
          ))}
          {list.length === 0 && (
            <div className="py-3 text-center text-xs text-muted-foreground">{t("table.noresults")}</div>
          )}
        </div>
        {!needle && list.length > PREVIEW + 1 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-1 flex h-7 w-full items-center justify-center gap-1 rounded-md text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/45"
          >
            {open ? t("pool.fewerJobs") : t("pool.allJobs", { n: list.length })}
            <ChevronDown aria-hidden className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          </button>
        )}
      </div>
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

function partitionWallSeconds(partition: string, policy?: Snapshot["policy"]) {
  const part = String(partition || "").split(",")[0];
  const wall = partitionCap(part, policy).wall;
  return wallLabelSec(wall);
}
