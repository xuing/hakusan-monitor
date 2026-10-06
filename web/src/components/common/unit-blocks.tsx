import { useT } from "@/i18n";
import { nf } from "@/lib/format";
import { cn } from "@/lib/utils";
import { scaleCells } from "@/lib/unit-cells";

/** Fewer cells than this: one continuous, proportional bar instead. */
const CONTINUOUS_BELOW = 4;

export function UnitBlocks({
  free,
  used,
  reserved,
  down,
  total,
  unit,
  schedulable,
  strandedLabel,
  cells = 48,
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
  /** most cells drawn; a larger pool is scaled down to this many */
  cells?: number;
  className?: string;
}) {
  const t = useT();
  if (total <= 0) return null;
  const stranded = schedulable !== undefined ? Math.max(0, free - schedulable) : 0;
  const okFree = schedulable !== undefined ? Math.min(schedulable, free) : free;
  const title = [
    // node bars (strandedLabel): idle and partly free nodes are two items,
    // not "1 node free (1 node partly free)"
    strandedLabel
      ? [okFree && t("blocks.free", { n: `${nf(okFree)} ${unit}` }), stranded && `${nf(stranded)} ${unit} ${strandedLabel}`]
          .filter(Boolean).join(" · ")
      : `${t("blocks.free", { n: `${nf(free)} ${unit}` })}${stranded ? ` (${nf(stranded)} ${unit} ${t("blocks.unusable")})` : ""}`,
    used && t("blocks.used", { n: `${nf(used)} ${unit}` }),
    reserved && t("blocks.reserved", { n: `${nf(reserved)} ${unit}` }),
    down && t("blocks.down", { n: `${nf(down)} ${unit}` }),
  ].filter(Boolean).join(" · ");
  // A bar of only a few cells can't show a split (the one-node large-memory
  // pool, 64 of 96 cores in use, drew one red cell): draw it as one
  // continuous bar, each part as wide as its share.
  if (cells < CONTINUOUS_BELOW && total > cells) {
    const part = (n: number, cls: string, key: string) =>
      n > 0 ? <span key={key} className={cn("h-full min-w-0", cls)} style={{ flexGrow: n, flexBasis: 0 }} /> : null;
    return (
      <div className={cn("flex h-2.5 w-36 shrink-0 gap-px overflow-hidden rounded-sm", className)} title={title}>
        {part(okFree, "bg-ok", "ok")}
        {part(stranded, "bg-warn", "stranded")}
        {part(reserved, "bg-warn", "reserved")}
        {part(used, "bg-bad", "used")}
        {part(down, "bg-muted-foreground/25 ring-1 ring-inset ring-muted-foreground/45", "down")}
      </div>
    );
  }
  const [okCells, strandedCells, usedCells, reservedCells, downCells] = scaleCells(
    [okFree, stranded, used, reserved, down],
    total,
    cells,
  );
  const cell = (n: number, cls: string, key: string) =>
    Array.from({ length: n }, (_, i) => (
      <span key={`${key}-${i}`} className={cn("h-2.5 min-w-0 flex-1 rounded-sm", cls)} />
    ));
  return (
    <div
      className={cn("flex h-2.5 w-36 shrink-0 gap-px", className)}
      title={title}
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
