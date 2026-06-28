import { Empty } from "@/components/common/empty";
import { SectionCard } from "@/components/common/section-card";
import { useLive } from "@/hooks/use-live";
import { useResourceFilter } from "@/hooks/use-resource-filter";
import { useT } from "@/i18n";
import { usersForPool } from "@/lib/derive";
import { nf } from "@/lib/format";

export function TopUsers() {
  const { snap } = useLive();
  const { filter } = useResourceFilter();
  const t = useT();
  if (!snap) return null;

  // when a resource is selected, show who's using *that* pool
  const users = filter === "all" ? snap.top_users : usersForPool(snap, filter);
  const max = Math.max(1, ...users.map((u) => u.cpus));

  return (
    <SectionCard title={t("section.topusers")}>
      {users.length === 0 ? (
        <Empty>—</Empty>
      ) : (
        <div className="space-y-2.5">
          {users.map((u) => (
            <div key={u.user}>
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-sm text-info-fg">{u.user}</span>
                <div className="flex gap-4 font-mono text-xs text-muted-foreground">
                  <span>
                    <b className="text-foreground">{u.running}</b> {t("topusers.jobs")}
                  </span>
                  <span>
                    <b className="text-foreground">{nf(u.cpus)}</b> {t("topusers.cores")}
                  </span>
                  {u.gpus > 0 && (
                    <span>
                      <b className="text-foreground">{u.gpus}</b> {t("topusers.gpus")}
                    </span>
                  )}
                </div>
              </div>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-info/70 transition-all duration-500"
                  style={{ width: `${(u.cpus / max) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
