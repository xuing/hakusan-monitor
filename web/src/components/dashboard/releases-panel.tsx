import { Empty } from "@/components/common/empty";
import { SectionCard } from "@/components/common/section-card";
import { Tag } from "@/components/common/tag";
import { useLive } from "@/hooks/use-live";
import { useResourceFilter } from "@/hooks/use-resource-filter";
import { useT } from "@/i18n";
import { fmtAt, fmtLeft } from "@/lib/format";
import { matchRelease } from "@/lib/slurm";

export function ReleasesPanel() {
  const { snap } = useLive();
  const { filter } = useResourceFilter();
  const t = useT();
  if (!snap) return null;

  const releases = snap.queue.releases.filter((r) => matchRelease(r, filter));

  return (
    <SectionCard title={t("section.releases")}>
      {releases.length === 0 ? (
        <Empty>{t("releases.none")}</Empty>
      ) : (
        <>
          <h3 className="mb-2 text-xs text-muted-foreground">{t("releases.soonest")}</h3>
          <div className="divide-y divide-border">
            {releases.map((r) => (
              <div key={String(r.job_id)} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 py-2">
                <div className="font-mono">
                  <div className="text-[13px]">{fmtAt(r.end_time)}</div>
                  <div className="text-[11px] text-ok-fg">{t("releases.in", { t: fmtLeft(r.time_left) })}</div>
                </div>
                <div className="flex min-w-0 items-center gap-2">
                  {r.gpus ? <Tag tone="info">{r.gpu}</Tag> : <Tag tone="neutral">{r.cpus}c</Tag>}
                  <span className="truncate text-[11px] text-muted-foreground">{r.partition}</span>
                </div>
                <span className="font-mono text-[11px] text-info-fg">{r.user}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </SectionCard>
  );
}
