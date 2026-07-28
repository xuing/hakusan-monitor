import { nf } from "@/lib/format";
import { cn } from "@/lib/utils";

export function UnitBlocks({
  free,
  used,
  reserved,
  down,
  total,
  unit,
  schedulable,
  className,
}: {
  free: number;
  used: number;
  reserved: number;
  down: number;
  total: number;
  unit: string;
  /** GPU pools only: of `free`, how many at least one sibling policy could
   *  actually grant right now — splits the free segment green/yellow instead
   *  of counting every physically-idle GPU as equally available. */
  schedulable?: number;
  className?: string;
}) {
  if (total <= 0) return null;
  const stranded = schedulable !== undefined ? Math.max(0, free - schedulable) : 0;
  const okFree = schedulable !== undefined ? Math.min(schedulable, free) : free;
  const [okCells, strandedCells, usedCells, reservedCells, downCells] = scaleCells(
    [okFree, stranded, used, reserved, down],
    total,
  );
  const cell = (n: number, cls: string, key: string) =>
    Array.from({ length: n }, (_, i) => (
      <span key={`${key}-${i}`} className={cn("h-2.5 min-w-0 flex-1 rounded-sm", cls)} />
    ));
  return (
    <div
      className={cn("flex h-2.5 w-36 shrink-0 gap-px", className)}
      title={`${nf(free)} ${unit} ${unit === "GPU" ? "free" : "available"}${stranded ? ` (${nf(stranded)} unused by any policy)` : ""} · ${nf(used)} used${reserved ? ` · ${nf(reserved)} reserved` : ""}${down ? ` · ${nf(down)} down` : ""}`}
    >
      {/* Reserved reads exactly like stranded — idle, reachable only via
          tweaks or the timed gap — so it sits solid amber with the free-ish
          cells up front, not hollow behind the used ones. */}
      {cell(okCells, "bg-ok", "ok")}
      {cell(strandedCells, "bg-warn", "stranded")}
      {cell(reservedCells, "bg-warn", "reserved")}
      {cell(usedCells, "bg-bad", "used")}
      {cell(downCells, "bg-bad/35 ring-1 ring-inset ring-bad/65", "down")}
    </div>
  );
}

function scaleCells(values: number[], total: number, maxCells = 48): number[] {
  const cells = Math.max(1, Math.min(maxCells, Math.round(total)));
  if (total <= maxCells) return values.map((v) => Math.max(0, Math.round(v)));
  const raw = values.map((v) => (Math.max(0, v) / total) * cells);
  const out = raw.map(Math.floor);
  let remaining = cells - out.reduce((sum, n) => sum + n, 0);
  raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac)
    .forEach(({ i }) => {
      if (remaining > 0) {
        out[i] += 1;
        remaining -= 1;
      }
    });
  return out;
}
