import { Empty } from "@/components/common/empty";
import { SectionCard } from "@/components/common/section-card";
import { useLive } from "@/hooks/use-live";
import { useResourceFilter } from "@/hooks/use-resource-filter";
import { useT } from "@/i18n";

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
        <div className="divide-y divide-border">
          {nd.slice(0, 8).map((n) => (
            <div key={n.name} className="grid grid-cols-[8rem_1fr] gap-3 py-2 text-xs">
              <div>
                <div className="font-mono">{n.name}</div>
                <div className="text-[10px] uppercase text-bad-fg">{n.state.join("+")}</div>
              </div>
              <div className="text-muted-foreground">{n.reason || "—"}</div>
            </div>
          ))}
          {nd.length > 8 && <div className="pt-2 text-xs text-muted-foreground">+{nd.length - 8}</div>}
        </div>
      )}
    </SectionCard>
  );
}
