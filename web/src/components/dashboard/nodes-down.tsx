import { Empty } from "@/components/common/empty";
import { SectionCard } from "@/components/common/section-card";
import { useLive } from "@/hooks/live-context";
import { useNow } from "@/hooks/use-now";
import { useResourceFilter } from "@/hooks/resource-filter-context";
import { durText, poolTitle, useT, type TFn } from "@/i18n";
import { clusterMs } from "@/lib/cluster-time";
import { compressHostlist, groupDownNodes, type DownGroup, type DownTone } from "@/lib/down-groups";
import { cn } from "@/lib/utils";
import type { Pool } from "@/types/snapshot";

const DOT: Record<DownTone, string> = { fault: "bg-bad", drain: "bg-warn", maint: "bg-muted-foreground/45" };
const CHIP: Record<DownTone, string> = { fault: "text-bad-fg", drain: "text-warn-fg", maint: "text-muted-foreground" };

/** Nodes out of service, one entry per cause: what is down, since when,
 *  who marked it, and which hosts. */
export function NodesDown() {
  const { snap } = useLive();
  const { filter } = useResourceFilter();
  const t = useT();
  if (!snap) return null;
  // when filtered, only show down nodes of the selected pool
  const nd = filter === "all" ? snap.nodes_down : snap.nodes_down.filter((n) => n.pool === filter);
  // a pool the cards show as "in maintenance" (every GPU offline)
  const maintPools = new Set(snap.pools.filter((p) => p.gpu?.maint).map((p) => p.id));
  const groups = groupDownNodes(nd, maintPools);

  return (
    <SectionCard
      title={t("section.nodesdown")}
      // the entries are causes, so say both counts
      extra={nd.length ? t("nodesdown.countCauses", { n: nd.length, causes: groups.length }) : ""}
      className="h-full"
      bodyClassName="flex min-h-0 flex-col"
    >
      {groups.length === 0 ? (
        <Empty>✓ {t("nodesdown.none")}</Empty>
      ) : (
        <div className="max-h-72 divide-y divide-border overflow-y-auto pr-1 xl:max-h-none xl:min-h-0 xl:flex-1">
          {groups.map((g) => (
            <DownEntry key={g.key} g={g} pools={snap.pools} t={t} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function DownEntry({ g, pools, t }: { g: DownGroup; pools: Pool[]; t: TFn }) {
  const nowMs = useNow();
  const startedMs = clusterMs(g.since);
  const lasted = Number.isFinite(startedMs) ? Math.max(0, (nowMs - startedMs) / 1000) : 0;
  // days for anything a day or longer: "181 天", not "181 天 3 小时"
  const lastedText = lasted >= 86400 ? t("dur.d", { n: Math.floor(lasted / 86400) }) : durText(t, lasted);
  return (
    <div className="flex gap-2.5 py-2.5 text-xs">
      <span aria-hidden className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", DOT[g.tone])} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {poolTitle(t, pools.find((p) => p.id === g.pool), g.pool)}
            <span className="font-normal text-muted-foreground"> · {t("nodesdown.count", { n: g.nodes.length })}</span>
          </span>
          {g.since && (
            <span className="shrink-0 whitespace-nowrap text-muted-foreground" title={g.since.replace("T", " ")}>
              {t("nodesdown.since", { date: g.since.slice(0, 10), dur: lastedText })}
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {g.states.map((state) => (
            <span
              key={state}
              className={cn("whitespace-nowrap rounded-sm border border-current/25 px-1 leading-4", CHIP[g.tone])}
            >
              {state.replace(/_/g, " ")}
            </span>
          ))}
          {g.reason && <span className="text-foreground/80">{g.reason}</span>}
          {g.by && (
            <span className="text-muted-foreground">
              · {g.by === "slurm" ? t("nodesdown.byAuto") : t("nodesdown.byUser", { user: g.by })}
            </span>
          )}
        </div>
        <div className="mt-1 break-all font-mono text-muted-foreground">{compressHostlist(g.nodes)}</div>
      </div>
    </div>
  );
}
