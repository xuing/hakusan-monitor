import { Bar } from "@/components/common/bar";
import { Empty } from "@/components/common/empty";
import { SectionCard } from "@/components/common/section-card";
import { useLive } from "@/hooks/use-live";
import { useResourceFilter } from "@/hooks/use-resource-filter";
import { useT } from "@/i18n";
import type { Tone } from "@/lib/slurm";
import { cn } from "@/lib/utils";
import type { DownNode } from "@/types/snapshot";

export function NodesDown() {
  const { snap } = useLive();
  const { filter } = useResourceFilter();
  const t = useT();
  if (!snap) return null;
  // when filtered, only show down nodes of the selected pool
  const nd = filter === "all" ? snap.nodes_down : snap.nodes_down.filter((n) => n.pool === filter);

  return (
    <SectionCard title={t("section.nodesdown")} extra={nd.length ? t("nodesdown.count", { n: nd.length }) : ""}>
      {nd.length === 0 ? (
        <Empty>✓ {t("nodesdown.none")}</Empty>
      ) : (
        <div className="max-h-72 overflow-y-auto pr-1">
          <div className="divide-y divide-border">
            {nd.map((n) => {
              const level = nodeAttention(n);
              return (
                <div key={n.name} className="grid gap-x-3 gap-y-1 py-2 text-xs sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:items-center">
                  <div className="min-w-0 truncate font-mono">{n.name}</div>
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="flex max-w-[13rem] shrink-0 items-center gap-1 overflow-x-auto">
                        {n.state.map((state) => (
                          <span
                            key={state}
                            className={cn(
                              "whitespace-nowrap rounded-sm border border-current/20 px-1 py-px text-xs uppercase leading-4",
                              level.text,
                            )}
                          >
                            {state.replace(/_/g, " ")}
                          </span>
                        ))}
                      </div>
                      <div className="min-w-0 truncate text-muted-foreground" title={n.reason || undefined}>
                        {n.reason || "—"}
                      </div>
                    </div>
                    <Bar value={level.value} tone={level.tone} className="mt-1 h-1" />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function nodeAttention(node: DownNode): { value: number; tone: Tone; text: string } {
  const states = new Set(node.state.map((s) => s.toUpperCase()));
  if (states.has("DOWN") || states.has("NOT_RESPONDING")) {
    return { value: 1, tone: "bad", text: "text-bad-fg" };
  }
  if (states.has("DRAIN") || states.has("DRAINING")) {
    return { value: 0.7, tone: "warn", text: "text-warn-fg" };
  }
  return { value: 0.45, tone: "neutral", text: "text-muted-foreground" };
}
