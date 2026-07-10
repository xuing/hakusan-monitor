import { useEffect, useState } from "react";
import { Tag } from "./tag";
import { clockOf, fmtDur, parseDur } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { NextFree } from "@/types/snapshot";

/** Shared earliest-GPU-release indicator for Overview and Partitions. */
export function GpuReleaseHint({
  next,
  generatedAt,
  className,
}: {
  next?: NextFree | null;
  generatedAt: number;
  className?: string;
}) {
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
        ~ {clockOf(next.at)} <span className="text-muted-foreground">({fmtDur(remaining)})</span>
      </span>
      <Tag tone="info">↑{releasingGpus} GPU</Tag>
    </div>
  );
}
