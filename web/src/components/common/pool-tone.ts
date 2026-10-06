import type { PoolTone } from "@/lib/pool-status";

/** One look per pool verdict (lib/pool-status): the filter chip, the group
 *  header and the pool card all colour themselves from these. */
export const POOL_DOT: Record<PoolTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  bad: "bg-bad",
  off: "bg-muted-foreground/45",
};

export const POOL_RING: Record<PoolTone, string> = {
  ok: "ring-ok/20",
  warn: "ring-warn/20",
  bad: "ring-bad/20",
  off: "ring-muted-foreground/10",
};

export const POOL_BORDER: Record<PoolTone, string> = {
  ok: "border-ok/40",
  warn: "border-warn/40",
  bad: "border-bad/40",
  off: "border-dashed border-muted-foreground/30 bg-muted/10",
};

export const POOL_TEXT: Record<PoolTone, string> = {
  ok: "text-ok-fg",
  warn: "text-warn-fg",
  bad: "text-bad-fg",
  off: "text-muted-foreground",
};
