import { Tag } from "@/components/common/tag";
import type { Tone } from "@/lib/slurm";

const NODE_STATE_TONE: Record<string, Tone> = {
  ALLOCATED: "info",
  MIXED: "warn",
  IDLE: "ok",
  DOWN: "bad",
  DRAIN: "bad",
  DRAINING: "bad",
  NOT_RESPONDING: "bad",
  FAIL: "bad",
  MAINT: "neutral",
  RESERVED: "neutral",
  PLANNED: "neutral",
  COMPLETING: "warn",
};

export function StateBadges({ states, onSelect }: { states: string[]; onSelect?: (state: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1">
      {states.map((s) => (
        <TagButton key={s} tone={NODE_STATE_TONE[s] ?? "neutral"} onClick={onSelect ? () => onSelect(s) : undefined}>
          {s}
        </TagButton>
      ))}
    </div>
  );
}

export function JobStateBadge({ state, onClick }: { state: string; onClick?: () => void }) {
  const tone: Tone = state === "RUNNING" ? "ok" : state === "PENDING" ? "warn" : "info";
  return (
    <TagButton tone={tone} onClick={onClick}>
      {state}
    </TagButton>
  );
}

function TagButton({ tone, children, onClick }: { tone: Tone; children: string; onClick?: () => void }) {
  if (!onClick) return <Tag tone={tone}>{children}</Tag>;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="inline-flex rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      title={children}
    >
      <Tag tone={tone} className="transition-opacity hover:opacity-80">
        {children}
      </Tag>
    </button>
  );
}

/** "alloc/total" with a compact load bar. */
export function AllocCell({ a, total }: { a: number; total: number }) {
  const r = total ? a / total : 0;
  const color = r >= 0.85 ? "var(--red-10)" : r >= 0.6 ? "var(--amber-10)" : "var(--green-10)";
  return (
    <div className="flex items-center gap-2">
      <span className="tnum w-14 font-mono text-xs">
        {a}/{total}
      </span>
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width: `${Math.round(r * 100)}%`, background: color }} />
      </div>
    </div>
  );
}
