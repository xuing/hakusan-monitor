import { useEffect, useState } from "react";
import { Tag } from "./tag";
import { clockOf, clusterDayOffset, fmtAt, parseDur } from "@/lib/format";
import { useT, type TFn } from "@/i18n";
import { cn } from "@/lib/utils";
import type { NextFree } from "@/types/snapshot";

/** Shared earliest-GPU-release indicator for Overview and Partitions.
 * "今天 02:39 释放 · 剩 ≤16 分钟": the day word + verb keep HH:MM from
 * reading as a duration, and ≤ is honest — jobs may end before their limit,
 * so the wait is at most that long. */
export function GpuReleaseHint({
  next,
  generatedAt,
  className,
}: {
  next?: NextFree | null;
  generatedAt: number;
  className?: string;
}) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!next) return;
    setNow(Date.now() / 1000);
    const id = setInterval(() => setNow(Date.now() / 1000), 30_000);
    return () => clearInterval(id);
  }, [next, generatedAt]);

  if (!next) return null;
  const remaining = Math.max(0, parseDur(next.left) - (now - generatedAt));
  const releasingGpus = Math.max(1, next.gpus ?? 1);
  return (
    <div className={cn("flex shrink-0 flex-col items-end gap-1 text-right text-xs", className)}>
      <span className="text-info-fg">
        {t("release.at", { time: dayClockLabel(next.at, t) })}
        <span className="text-muted-foreground"> · {t("release.left", { dur: fmtDurWords(remaining, t) })}</span>
      </span>
      <Tag tone="info">↑{releasingGpus} GPU</Tag>
    </div>
  );
}

function dayClockLabel(iso: string, t: TFn): string {
  const offset = clusterDayOffset(iso);
  if (offset === 0) return `${t("day.today")} ${clockOf(iso)}`;
  if (offset === 1) return `${t("day.tomorrow")} ${clockOf(iso)}`;
  return fmtAt(iso);
}

/** fmtDur with localized units ("6 小时 30 分钟" instead of "6h 30m"). */
function fmtDurWords(sec: number, t: TFn): string {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return h ? `${t("dur.d", { n: d })} ${t("dur.h", { n: h })}` : t("dur.d", { n: d });
  if (h > 0) return m ? `${t("dur.h", { n: h })} ${t("dur.m", { n: m })}` : t("dur.h", { n: h });
  return t("dur.m", { n: m });
}
