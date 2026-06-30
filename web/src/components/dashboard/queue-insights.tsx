import type { ReactNode } from "react";
import { Empty } from "@/components/common/empty";
import { SectionCard } from "@/components/common/section-card";
import { useLive } from "@/hooks/use-live";
import { reasonLabel, useT } from "@/i18n";
import { fmtAt } from "@/lib/format";
import { toneClass, type Tone } from "@/lib/slurm";
import { cn } from "@/lib/utils";

export function QueueInsights() {
  const { snap } = useLive();
  const t = useT();
  if (!snap) return null;
  const q = snap.queue;

  const reasonEntries = Object.entries(q.pending_reasons).sort((a, b) => b[1] - a[1]);
  const reasonTotal = reasonEntries.reduce((sum, [, n]) => sum + n, 0);

  return (
    <SectionCard title={t("section.queue")}>
      <div className="mb-4 flex flex-wrap gap-2">
        <Chip tone="ok" n={q.running} label={t("queue.running")} />
        <Chip tone="warn" n={q.pending} label={t("queue.pending")} />
        {q.container_jobs > 0 && <Chip n={q.container_jobs} label={t("queue.containers")} />}
      </div>

      {reasonTotal > 0 && (
        <div className="mb-4">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h3 className="text-xs text-muted-foreground">{t("queue.reasons")}</h3>
            <span className="tnum text-[11px] text-muted-foreground">{reasonTotal}</span>
          </div>
          <div className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-muted">
            {reasonEntries.map(([reason, n]) => (
              <div
                key={reason}
                className={cn("h-full first:rounded-l-full last:rounded-r-full", toneClass[reasonTone(reason)].dot)}
                style={{ width: `${(n / reasonTotal) * 100}%`, minWidth: "3px" }}
                title={`${reasonLabel(t, reason)} · ${n}`}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {reasonEntries.map(([reason, n]) => (
              <span key={reason} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className={cn("h-2 w-2 shrink-0 rounded-full", toneClass[reasonTone(reason)].dot)} />
                {reasonLabel(t, reason)}
                <span className="tnum text-foreground">{n}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {q.top_pending.length === 0 ? (
        <Empty>{t("queue.none")}</Empty>
      ) : (
        <>
          <h3 className="mb-2 text-xs text-muted-foreground">{t("queue.longest")}</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <Th>{t("col.job")}</Th>
                  <Th>{t("col.user")}</Th>
                  <Th>{t("col.partition")}</Th>
                  <Th>{t("col.gpu")}/CPU</Th>
                  <Th>{t("col.reason")}</Th>
                  <Th>{t("col.startEst")}</Th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {q.top_pending.slice(0, 6).map((j) => (
                  <tr key={String(j.job_id)} className="border-t border-border">
                    <Td>{j.job_id}</Td>
                    <Td className="text-info-fg">{j.user}</Td>
                    <Td>{j.partition}</Td>
                    <Td>{j.gpu || `${j.cpus}c`}</Td>
                    <Td className="text-muted-foreground">{reasonLabel(t, j.reason)}</Td>
                    <Td className="text-muted-foreground">{j.start_est ? fmtAt(j.start_est) : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </SectionCard>
  );
}

// Group Slurm pending reasons into three readable buckets:
//   info (blue)    — waiting for free hardware
//   warn (amber)   — blocked by a QOS / policy limit
//   neutral (grey) — ordering / dependency / being scheduled (Priority, Dependency, None…)
// Slurm can emit verbose reasons (e.g. "Nodes required for job are DOWN, …"), so
// match on the first word, mirroring reasonLabel's normalization.
function reasonTone(reason: string): Tone {
  const word = (reason || "").split(/[\s_]/)[0];
  if (["Resources", "Nodes", "ReqNodeNotAvail", "NodeDown", "Reservation"].includes(word)) return "info";
  if (word.startsWith("QOS") || /Limit|Max/.test(reason)) return "warn";
  return "neutral";
}

function Chip({ tone, n, label }: { tone?: Tone; n: number; label: string }) {
  const c = toneClass[tone ?? "neutral"];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1 text-xs">
      <b className={cn("font-mono text-sm", c.text)}>{n}</b>
      {label}
    </span>
  );
}

const Th = ({ children }: { children: ReactNode }) => (
  <th className="whitespace-nowrap pb-1.5 pr-3 font-medium">{children}</th>
);
const Td = ({ children, className }: { children: ReactNode; className?: string }) => (
  <td className={cn("whitespace-nowrap py-1.5 pr-3", className)}>{children}</td>
);
