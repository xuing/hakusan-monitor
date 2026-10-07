import { Tag } from "./tag";
import { dayClockLabel } from "./verdict-text";
import { useNow } from "@/hooks/use-now";
import { parseDur } from "@/lib/format";
import { durText, useT } from "@/i18n";
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
  const now = useNow() / 1000;

  if (!next) return null;
  const remaining = Math.max(0, parseDur(next.left) - (now - generatedAt));
  const releasingGpus = Math.max(1, next.gpus ?? 1);
  return (
    <div className={cn("flex shrink-0 flex-col items-end gap-1 text-right text-xs", className)}>
      <span className="text-info-fg">
        {t("release.at", { time: dayClockLabel(next.at, t) })}
        <span className="text-muted-foreground"> · {t("release.left", { dur: durText(t, remaining) })}</span>
      </span>
      <Tag tone="info">↑{releasingGpus} GPU</Tag>
    </div>
  );
}


