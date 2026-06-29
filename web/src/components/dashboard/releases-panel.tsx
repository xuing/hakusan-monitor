import { useEffect, useState } from "react";
import { Empty } from "@/components/common/empty";
import { SectionCard } from "@/components/common/section-card";
import { Tag } from "@/components/common/tag";
import { useLive } from "@/hooks/use-live";
import { useResourceFilter } from "@/hooks/use-resource-filter";
import { useT, type TFn } from "@/i18n";
import { fmtCountdown, parseDur } from "@/lib/format";
import { matchRelease } from "@/lib/slurm";
import type { Release } from "@/types/snapshot";

export function ReleasesPanel() {
  const { snap } = useLive();
  const { filter } = useResourceFilter();
  const t = useT();
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, []);
  if (!snap) return null;

  const releases = snap.queue.releases.filter((r) => matchRelease(r, filter));

  return (
    <SectionCard title={t("section.releases")}>
      {releases.length === 0 ? (
        <Empty>{t("releases.none")}</Empty>
      ) : (
        <>
          <h3 className="mb-2 text-xs text-muted-foreground">{t("releases.soonest")}</h3>
          <div className="max-h-72 overflow-y-auto pr-1">
            {releases.map((r) => (
              <ReleaseRow key={String(r.job_id)} release={r} now={now} generatedAt={snap.generated_at} t={t} />
            ))}
          </div>
        </>
      )}
    </SectionCard>
  );
}

function ReleaseRow({
  release,
  now,
  generatedAt,
  t,
}: {
  release: Release;
  now: number;
  generatedAt: number;
  t: TFn;
}) {
  const remaining = Math.max(0, parseDur(release.time_left) - (now - generatedAt));
  const resource = release.gpus ? release.gpu : `${release.cpus}c`;
  return (
    <div className="mb-1 grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-md bg-muted/30 px-2.5 py-1.5 text-[11px] last:mb-0">
      <Tag tone={release.gpus ? "info" : "neutral"}>{resource}</Tag>
      <div className="min-w-0">
        <div className="truncate font-mono text-info-fg">{release.user}</div>
        <div className="truncate text-[10px] text-muted-foreground">{release.partition}</div>
      </div>
      <div className="tnum whitespace-nowrap font-mono text-ok-fg">{t("releases.in", { t: fmtCountdown(remaining) })}</div>
    </div>
  );
}
