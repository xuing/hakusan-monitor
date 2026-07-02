import { Tag } from "@/components/common/tag";
import { utilTone, type Tone } from "@/lib/slurm";

const NODE_STATE_TONE: Record<string, Tone> = {
  ALLOCATED: "info",
  MIXED: "warn",
  IDLE: "ok",
  DOWN: "bad",
  // draining = administratively leaving but still healthy/running jobs — warn,
  // matching the Overview "nodes needing attention" panel (down stays red).
  DRAIN: "warn",
  DRAINING: "warn",
  NOT_RESPONDING: "bad",
  FAIL: "bad",
  MAINT: "neutral",
  RESERVED: "neutral",
  PLANNED: "neutral",
  COMPLETING: "warn",
};

const JOB_STATE_TONE: Record<string, Tone> = {
  RUNNING: "ok",
  PENDING: "warn",
  COMPLETING: "info",
  COMPLETED: "info",
  SUSPENDED: "neutral",
  FAILED: "bad",
  CANCELLED: "bad",
  TIMEOUT: "bad",
  NODE_FAIL: "bad",
  OUT_OF_MEMORY: "bad",
  PREEMPTED: "bad",
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
  const tone: Tone = JOB_STATE_TONE[state] ?? "neutral";
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

const TONE_BAR: Record<Tone, string> = {
  ok: "var(--green-10)",
  warn: "var(--amber-10)",
  bad: "var(--red-10)",
  info: "var(--blue-10)",
  neutral: "hsl(var(--muted-foreground))",
};

/** "alloc/total" with a compact load bar. */
export function AllocCell({ a, total }: { a: number; total: number }) {
  const r = total ? a / total : 0;
  const color = TONE_BAR[utilTone(r)];
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
