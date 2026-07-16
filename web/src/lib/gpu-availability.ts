export type GpuAvailabilitySegmentKind =
  | "ready"
  | "contested"
  | "memory"
  | "cpu"
  | "cpu-memory"
  | "constrained"
  | "reserved"
  | "down"
  | "full";

export interface GpuAvailabilitySegment {
  kind: GpuAvailabilitySegmentKind;
  count: number;
}

export interface GpuAvailabilitySegmentInput {
  unreservedFree: number;
  schedulable: number;
  reserved: number;
  down: number;
  hasClearSlot: boolean;
  constrainedContested: boolean;
  shortCpu: boolean;
  shortMemory: boolean;
}

/** Split the overview's physical-idle total into mutually exclusive, useful
 * states. The UI deliberately renders these as peers instead of promoting one
 * part of the total to a second, apparently contradictory headline. */
export function gpuAvailabilitySegments(input: GpuAvailabilitySegmentInput): GpuAvailabilitySegment[] {
  const free = count(input.unreservedFree);
  const schedulable = Math.min(free, count(input.schedulable));
  const constrained = free - schedulable;
  const segments: GpuAvailabilitySegment[] = [];

  if (schedulable > 0) {
    append(segments, {
      kind: input.hasClearSlot ? "ready" : "contested",
      count: schedulable,
    });
  }
  if (constrained > 0) {
    append(segments, {
      kind: input.constrainedContested
        ? "contested"
        : shortageKind(input.shortCpu, input.shortMemory),
      count: constrained,
    });
  }
  if (input.reserved > 0) segments.push({ kind: "reserved", count: count(input.reserved) });
  if (input.down > 0) segments.push({ kind: "down", count: count(input.down) });
  if (segments.length === 0) segments.push({ kind: "full", count: 0 });
  return segments;
}

function shortageKind(shortCpu: boolean, shortMemory: boolean): GpuAvailabilitySegmentKind {
  if (shortCpu && shortMemory) return "cpu-memory";
  if (shortCpu) return "cpu";
  if (shortMemory) return "memory";
  return "constrained";
}

function append(segments: GpuAvailabilitySegment[], next: GpuAvailabilitySegment) {
  const previous = segments.at(-1);
  if (previous?.kind === next.kind) previous.count += next.count;
  else segments.push(next);
}

function count(value: number) {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}
