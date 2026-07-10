import { useEffect, useState } from "react";
import { Tag } from "./tag";
import { clockOrDate, fmtDur, parseDur } from "@/lib/format";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import type { NextFree } from "@/types/snapshot";

/** Shared earliest-GPU-release indicator for Overview and Partitions.
 * "02:39 释放 · 剩 ≤16m": the verb glued to the clock keeps HH:MM from
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
        {t("release.at", { time: clockOrDate(next.at) })}
        <span className="text-muted-foreground"> · {t("release.left", { dur: fmtDur(remaining) })}</span>
      </span>
      <Tag tone="info">↑{releasingGpus} GPU</Tag>
    </div>
  );
}
