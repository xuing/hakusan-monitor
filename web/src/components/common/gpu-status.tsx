/** Presentation for gpu-availability's verdicts. One vocabulary and one colour
 *  rule, shared by the Overview pool cards and the Partitions page, so a GPU
 *  can never read "available" on one screen and "reserved" on the other. */
import type { TranslationKey, TFn } from "@/i18n";
import type { GpuAvailabilityKind } from "@/lib/gpu-availability";

const LABEL_KEYS: Record<GpuAvailabilityKind, TranslationKey> = {
  ready: "pool.gpuStatusReady",
  contested: "pool.gpuStatusContested",
  memory: "pool.gpuStatusMemory",
  cpu: "pool.gpuStatusCpu",
  "cpu-memory": "pool.gpuStatusCpuMemory",
  reserved: "pool.gpuStatusReserved",
  down: "pool.gpuStatusDown",
  full: "pool.gpuStatusFull",
};

export function gpuSegmentLabel(kind: GpuAvailabilityKind, t: TFn) {
  return t(LABEL_KEYS[kind]);
}

export function gpuSegmentTextClass(kind: GpuAvailabilityKind) {
  if (kind === "ready") return "text-ok-fg";
  if (kind === "down") return "text-bad-fg";
  if (kind === "full") return "text-muted-foreground";
  // Resource constraints, queue contention, and scheduler reservations all
  // mean "idle but not directly available" and intentionally share amber.
  return "text-warn-fg";
}
