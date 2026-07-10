import type { ReactNode } from "react";
import { Empty } from "@/components/common/empty";
import { SectionCard } from "@/components/common/section-card";
import { useLive } from "@/hooks/live-context";
import { reasonLabel, useT } from "@/i18n";
import { fmtAt, fmtEpoch } from "@/lib/format";
import { partitionDisplayRank, toneClass, type Tone } from "@/lib/slurm";
import { cn } from "@/lib/utils";

export function QueueInsights() {
  const { snap } = useLive();
  const t = useT();
  if (!snap) return null;
  const q = snap.queue;

  const reasonEntries = Object.entries(q.pending_reasons).sort((a, b) => b[1] - a[1]);
  const reasonTotal = reasonEntries.reduce((sum, [, n]) => sum + n, 0);
  const longestSource = q.longest_pending_by_partition?.length ? q.longest_pending_by_partition : q.top_pending;
  const longestPending = [...longestSource].sort(
    (a, b) =>
      partitionDisplayRank(a.partition) - partitionDisplayRank(b.partition)
      || String(a.partition || "").localeCompare(String(b.partition || ""))
      || (a.submit_time || 0) - (b.submit_time || 0),
  );

  return (
    <SectionCard title={t("section.queue")} className="h-full">
      <div className="mb-4 flex flex-wrap gap-2">
        <Chip tone="ok" n={q.running} label={t("queue.running")} />
        <Chip tone="warn" n={q.pending} label={t("queue.pending")} />
        {q.container_jobs > 0 && <Chip n={q.container_jobs} label={t("queue.containers")} />}
      </div>

      {reasonTotal > 0 && (
        <div className="mb-4">
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h3 className="text-xs text-muted-foreground">{t("queue.reasons")}</h3>
            <span className="tnum text-xs text-muted-foreground">{reasonTotal}</span>
          </div>
          <div className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-muted">
            {reasonEntries.map(([reason, n]) => (
              <div
                key={reason}
                className="h-full first:rounded-l-full last:rounded-r-full"
                style={{ width: `${(n / reasonTotal) * 100}%`, minWidth: "3px", backgroundColor: reasonColor(reason) }}
                title={`${reasonLabel(t, reason)} · ${n}`}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {reasonEntries.map(([reason, n]) => (
              <span key={reason} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: reasonColor(reason) }} />
                {reasonLabel(t, reason)}
                <span className="tnum text-foreground">{n}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {longestPending.length === 0 ? (
        <Empty>{t("queue.none")}</Empty>
      ) : (
        <>
          <h3 className="mb-2 text-xs text-muted-foreground">{t("queue.longest")}</h3>
          <div className="max-h-72 overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="sticky top-0 bg-card text-left text-muted-foreground">
                  <Th>{t("col.partition")}</Th>
                  <Th>{t("col.job")}</Th>
                  <Th>{t("col.user")}</Th>
                  <Th>{t("col.gpu")}/CPU</Th>
                  <Th>{t("col.reason")}</Th>
                  <Th>{t("col.submit")}</Th>
                  <Th>{t("col.startEst")}</Th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {longestPending.map((j) => (
                  <tr key={`${j.partition}-${String(j.job_id)}`} className="border-t border-border">
                    <Td>{j.partition || "—"}</Td>
                    <Td>{j.job_id}</Td>
                    <Td className="text-info-fg">{j.user}</Td>
                    <Td>{j.gpu || `${j.cpus}c`}</Td>
                    <Td className="text-muted-foreground">{reasonLabel(t, j.reason)}</Td>
                    <Td className="text-muted-foreground">{fmtEpoch(j.submit_time)}</Td>
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

function reasonColor(reason: string) {
  const word = (reason || "").split(/[\s_]/)[0];
  if (reason === "Priority") return "var(--slate-10)";
  if (reason === "Dependency") return "var(--green-10)";
  if (reason === "QOSMaxJobsPerUserLimit") return "hsl(262 56% 58%)";
  if (reason === "QOSMaxCpuPerJobLimit") return "hsl(24 78% 47%)";
  if (reason === "JobArrayTaskLimit") return "hsl(189 72% 42%)";
  if (word === "Resources") return "var(--blue-10)";
  if (["Nodes", "ReqNodeNotAvail", "NodeDown"].includes(word) || /DOWN|DRAIN|Unavailable/i.test(reason)) return "var(--red-10)";
  if (word === "BeginTime") return "hsl(199 72% 45%)";
  if (word === "Reservation") return "hsl(330 58% 52%)";
  if (word === "None") return "var(--gray-10)";
  if (word.startsWith("QOS") || /Limit|Max/.test(reason)) return "var(--amber-10)";
  return FALLBACK_REASON_COLORS[hashReason(reason) % FALLBACK_REASON_COLORS.length];
}

const FALLBACK_REASON_COLORS = [
  "hsl(206 82% 48%)",
  "hsl(168 64% 36%)",
  "hsl(262 56% 58%)",
  "hsl(24 78% 47%)",
  "hsl(330 58% 52%)",
  "hsl(215 16% 47%)",
];

function hashReason(reason: string) {
  let h = 0;
  for (let i = 0; i < reason.length; i += 1) h = (h * 31 + reason.charCodeAt(i)) >>> 0;
  return h;
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
