import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Empty } from "@/components/common/empty";
import { SectionCard } from "@/components/common/section-card";
import { useLive } from "@/hooks/use-live";
import { useResourceFilter } from "@/hooks/use-resource-filter";
import { useT } from "@/i18n";
import { fmtCountdown, parseDur } from "@/lib/format";
import { matchRelease } from "@/lib/slurm";
import { cn } from "@/lib/utils";
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
    <SectionCard title={t("section.releases")} className="h-full" bodyClassName="flex min-h-0 flex-col">
      {releases.length === 0 ? (
        <Empty>{t("releases.none")}</Empty>
      ) : (
        <div className="subtle-scroll min-h-0 flex-1 overflow-y-auto pr-1">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-1.5">
            {releases.map((r) => (
              <ReleaseRow key={String(r.job_id)} release={r} now={now} generatedAt={snap.generated_at} />
            ))}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

function ReleaseRow({
  release,
  now,
  generatedAt,
}: {
  release: Release;
  now: number;
  generatedAt: number;
}) {
  const remaining = Math.max(0, parseDur(release.time_left) - (now - generatedAt));
  const resource = release.gpus ? release.gpu : `${release.cpus}c`;
  const isGpu = release.gpus > 0;
  const accent = isGpu ? "bg-info" : "bg-ok";
  const fg = isGpu ? "text-info-fg" : "text-ok-fg";
  const soft = isGpu ? "bg-info-soft text-info-fg" : "bg-ok-soft text-ok-fg";
  return (
    <div className="rounded-md bg-muted/40 px-2.5 py-1.5 transition-colors hover:bg-muted/60">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", accent)} />
          <span className="truncate font-mono text-[12px] font-medium text-info-fg">{release.user}</span>
        </span>
        <span className={cn("tnum inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[10px] font-medium", soft)}>
          <Clock className="h-2.5 w-2.5" />
          {fmtCountdown(remaining)}
        </span>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 pl-3 text-[10px] text-muted-foreground">
        <span className={cn("font-medium", fg)}>{resource}</span>
        <span className="text-muted-foreground/40">·</span>
        <span className="truncate">{release.partition}</span>
      </div>
    </div>
  );
}
