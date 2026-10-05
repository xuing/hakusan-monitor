import { useT } from "@/i18n";
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
  strandedLabel,
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
  /** Tooltip wording for the amber part of `free` (CPU node bars use it for
   *  nodes with only some cores free). */
  strandedLabel?: string;
  className?: string;
}) {
  const t = useT();
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
      title={[
        `${t("blocks.free", { n: `${nf(free)} ${unit}` })}${stranded ? ` (${nf(stranded)} ${strandedLabel ?? t("blocks.unusable")})` : ""}`,
        used && t("blocks.used", { n: nf(used) }),
        reserved && t("blocks.reserved", { n: nf(reserved) }),
        down && t("blocks.down", { n: nf(down) }),
      ].filter(Boolean).join(" · ")}
    >
      {/* Reserved reads exactly like stranded — idle, reachable only via
          tweaks or the timed gap — so it sits solid amber with the free-ish
          cells up front, not hollow behind the used ones. */}
      {cell(okCells, "bg-ok", "ok")}
      {cell(strandedCells, "bg-warn", "stranded")}
      {cell(reservedCells, "bg-warn", "reserved")}
      {cell(usedCells, "bg-bad", "used")}
      {cell(downCells, "bg-muted-foreground/25 ring-1 ring-inset ring-muted-foreground/45", "down")}
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
