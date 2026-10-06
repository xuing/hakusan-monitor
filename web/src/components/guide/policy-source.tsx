// "集群策略原文与解读": conclusions drawn from the cluster's own policy texts
// (job_submit.lua, sacctmgr QoS, scontrol partitions), then the texts
// themselves. Collapsed by default — one status line until opened. Every
// statement is computed from snapshot/policy-source data.
import { useMemo, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { ChartPlaceholder } from "@/components/common/chart-placeholder";
import { CopyButton } from "@/components/common/copy-button";
import { Empty } from "@/components/common/empty";
import { useApi } from "@/hooks/use-api";
import { useLive } from "@/hooks/live-context";
import { useT } from "@/i18n";
import { api } from "@/lib/api";
import { clusterTimeZone } from "@/lib/cluster-time";
import { nf } from "@/lib/format";
import { type Tone } from "@/lib/slurm";
import { partitionOrderRank } from "@/lib/site";
import { cn } from "@/lib/utils";
import type {
  DynamicPartitionCap,
  DynamicPartitionPolicy,
  PartitionDefaults,
  PolicyCheckReport,
  PolicySnapshot,
} from "@/types/snapshot";

interface Row {
  name: string;
  cap: DynamicPartitionCap | undefined;
  policy: DynamicPartitionPolicy;
  defaults: PartitionDefaults;
}

/** Date-time with the year — file mtimes span months, unlike the dashboard's
 *  intra-day clocks. */
function fmtDateTime(ts: number | undefined): string {
  if (!ts) return "—";
  // sv-SE renders ISO-like "2026-10-01 15:58", unambiguous in every UI language
  return new Date(ts * 1000).toLocaleString("sv-SE", {
    timeZone: clusterTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function buildRows(policy: PolicySnapshot): Row[] {
  const names = new Set<string>([
    ...Object.keys(policy.partition_caps ?? {}),
    ...Object.keys(policy.partition_defaults ?? {}),
  ]);
  return [...names]
    .map((name): Row => {
      const defaults = policy.partition_defaults?.[name] ?? {};
      return {
        name,
        cap: policy.partition_caps?.[name],
        policy: policy.partition_policies?.[name] ?? {},
        defaults,
      };
    })
    .sort((a, b) => partitionOrderRank(a.name) - partitionOrderRank(b.name) || a.name.localeCompare(b.name));
}

function Callout({ tone, children }: { tone: Tone; children: ReactNode }) {
  const box: Record<Tone, string> = {
    ok: "border-ok/35 bg-ok-soft/45",
    warn: "border-warn/35 bg-warn-soft/45",
    bad: "border-bad/35 bg-bad-soft/45",
    info: "border-info/35 bg-info-soft/45",
    neutral: "border-border bg-muted/30",
  };
  return (
    <div className={cn("rounded-md border px-2.5 py-2 text-xs leading-relaxed text-foreground", box[tone])}>
      {children}
    </div>
  );
}

function RawBlock({ title, meta, text }: { title: string; meta?: ReactNode; text: string }) {
  const t = useT();
  const lines = text ? text.split("\n").length : 0;
  return (
    <details className="group rounded-lg border border-border bg-muted/20">
      <summary className="flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-2 text-sm marker:text-muted-foreground">
        <span className="font-mono text-xs font-semibold">{title}</span>
        {meta && <span className="font-mono text-xs text-muted-foreground">{meta}</span>}
        <span className="ml-auto font-mono text-xs text-muted-foreground">{t("guide.policy.lines", { n: nf(lines) })}</span>
      </summary>
      <div className="border-t border-border/60 px-3 pb-3 pt-2">
        <div className="mb-1 flex justify-end">
          <CopyButton text={text} label />
        </div>
        <pre className="max-h-96 overflow-auto rounded-md bg-background p-3 font-mono text-xs leading-relaxed text-foreground/90">
          {text}
        </pre>
      </div>
    </details>
  );
}

export function PolicySourceSection() {
  const t = useT();
  const { snap } = useLive();
  // the texts are large and change daily — fetched once, never polled
  const { data, loading } = useApi(() => api.policySource(), null, 0);
  const policy = snap?.policy;
  const rows = useMemo(() => (policy ? buildRows(policy) : []), [policy]);
  const check: PolicyCheckReport | null = data?.check ?? null;
  const lua = data?.lua ?? policy?.lua;

  if (!policy && !data) {
    return (
      <CollapsedCard title={t("guide.policy.title")} status={loading ? "…" : t("guide.policy.checkedNone")}>
        {loading ? <ChartPlaceholder className="h-24" /> : <Empty>{t("guide.policy.noData")}</Empty>}
      </CollapsedCard>
    );
  }

  // ---- header facts: when read, when verified, with what result --------------
  const checkedAt = check?.checked_at ?? policy?.check?.checked_at;
  const badParts = check?.partitions
    ? Object.entries(check.partitions).filter(([, v]) => v.ok === false).map(([k]) => k)
    : policy?.check?.mismatches ?? [];
  // quick-request values the UI offers that Slurm would reject or never start
  const boundary = check?.boundary;
  const badBounds = (boundary?.problems ?? []).map((b) => `${b.partition} ${b.field}=${b.value}`);
  const checkLine = !checkedAt
    ? t("guide.policy.checkedNone")
    : badParts.length || badBounds.length
      ? t("guide.policy.checkedBad", { time: fmtDateTime(checkedAt), parts: [...badParts, ...badBounds].join(", ") })
      : boundary?.checked
        ? t("guide.policy.checkedOkBoundary", { time: fmtDateTime(checkedAt), n: boundary.checked })
        : t("guide.policy.checkedOk", { time: fmtDateTime(checkedAt) });

  // ---- findings, each only when its condition holds in the data --------------
  const luaMemIgnored = rows
    .filter((r) => {
      const d = r.defaults;
      return d.lua_mem_per_node_mb && d.def_mem_per_cpu_mb && d.cores
        && d.lua_mem_per_node_mb !== d.def_mem_per_cpu_mb * d.cores;
    })
    .map((r) => r.name);
  const noGpuCap = rows.filter((r) => r.defaults.gpus_per_node && r.cap && !r.cap.maxGpus).map((r) => r.name);
  const findings: { key: string; tone: Tone; text: string }[] = [];
  if (badParts.length) {
    findings.push({ key: "mismatch", tone: "bad", text: t("guide.policy.find.mismatch", { parts: badParts.join(", ") }) });
  }
  if (badBounds.length) {
    findings.push({ key: "boundary", tone: "bad", text: t("guide.policy.find.boundary", { list: badBounds.join(", ") }) });
  }
  if (noGpuCap.length) {
    findings.push({ key: "nogpucap", tone: "info", text: t("guide.policy.find.noGpuCap", { parts: noGpuCap.join(", ") }) });
  }
  if (luaMemIgnored.length) {
    findings.push({ key: "luamem", tone: "info", text: t("guide.policy.find.luaMem", { n: luaMemIgnored.length }) });
  }

  const luaMeta = [lua?.path, lua?.sha ? `sha ${lua.sha}` : ""].filter(Boolean).join(" · ");
  const statusTone = badParts.length || badBounds.length ? "text-bad-fg" : checkedAt ? "text-ok-fg" : "text-muted-foreground";

  return (
    <CollapsedCard title={t("guide.policy.title")} status={<span className={statusTone}>{checkLine}</span>}>
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("guide.policy.lead", { time: fmtDateTime(data?.fetched_at || policy?.generated_at) })}
        </p>
        {findings.length > 0 && (
          <div className="space-y-1.5">
            {findings.map((f) => <Callout key={f.key} tone={f.tone}>{f.text}</Callout>)}
          </div>
        )}
        {data && (data.lua_text || data.qos_text || data.partitions_text) && (
          <div className="space-y-2">
            {data.lua_text && <RawBlock title="job_submit.lua" meta={luaMeta || undefined} text={data.lua_text} />}
            {data.qos_text && <RawBlock title={t("guide.policy.raw.qos")} text={data.qos_text} />}
            {data.partitions_text && <RawBlock title={t("guide.policy.raw.partitions")} text={data.partitions_text} />}
          </div>
        )}
      </div>
    </CollapsedCard>
  );
}

/** A section card that starts closed: the header line (title + one-line
 *  status) is all it costs until someone wants the detail. */
function CollapsedCard({ title, status, children }: { title: string; status: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <details className="group">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
          <span className="ml-auto font-mono text-xs">{status}</span>
        </summary>
        <div className="border-t border-border/60 px-4 pb-4 pt-3">{children}</div>
      </details>
    </section>
  );
}
