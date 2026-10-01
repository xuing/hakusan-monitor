// "集群策略原文与解读": the cluster's own policy texts (job_submit.lua, the
// sacctmgr QoS table, scontrol partitions) next to our reading of them.
// Every number on this card is computed from snapshot/policy-source data —
// nothing about the cluster is written into the component or its strings.
import { useMemo, type ReactNode } from "react";
import { ChartPlaceholder } from "@/components/common/chart-placeholder";
import { CopyButton } from "@/components/common/copy-button";
import { Empty } from "@/components/common/empty";
import { SectionCard } from "@/components/common/section-card";
import { Tag } from "@/components/common/tag";
import { useApi } from "@/hooks/use-api";
import { useLive } from "@/hooks/live-context";
import { useT, type TFn, type TranslationKey } from "@/i18n";
import { api } from "@/lib/api";
import { CLUSTER_TIME_ZONE, fmtMB, nf } from "@/lib/format";
import { fmtCapMem } from "@/lib/policy-hints";
import {
  fmtWallMinutes,
  isMaterialsStudioPartition,
  partitionDisplayRank,
  type Tone,
} from "@/lib/slurm";
import { cn } from "@/lib/utils";
import type {
  DynamicPartitionCap,
  DynamicPartitionPolicy,
  LuaVersion,
  PartitionDefaults,
  PolicyCheckReport,
  PolicySnapshot,
  Snapshot,
} from "@/types/snapshot";

type Group = "gpu" | "cpu" | "vm" | "ms" | "other";
const GROUP_ORDER: Group[] = ["gpu", "cpu", "vm", "ms", "other"];

interface Row {
  name: string;
  group: Group;
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
    timeZone: CLUSTER_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function partitionGroup(name: string, defaults: PartitionDefaults, snap: Snapshot | null): Group {
  const live = snap?.partitions.find((p) => p.name === name);
  if (isMaterialsStudioPartition(name) || name.startsWith("MS_")) return "ms";
  if (live?.kind === "gpu" || defaults.gpus_per_node || /GPU/i.test(name)) return "gpu";
  if (name.startsWith("VM-")) return "vm";
  if (live) return "cpu";
  return "other";
}

function buildRows(policy: PolicySnapshot, snap: Snapshot | null): Row[] {
  const names = new Set<string>([
    ...Object.keys(policy.partition_caps ?? {}),
    ...Object.keys(policy.partition_defaults ?? {}),
  ]);
  return [...names]
    .map((name): Row => {
      const defaults = policy.partition_defaults?.[name] ?? {};
      return {
        name,
        group: partitionGroup(name, defaults, snap),
        cap: policy.partition_caps?.[name],
        policy: policy.partition_policies?.[name] ?? {},
        defaults,
      };
    })
    .sort((a, b) => partitionDisplayRank(a.name) - partitionDisplayRank(b.name) || a.name.localeCompare(b.name));
}

/** "26c / 256GiB / 1 GPU / 1 node / 7d" — every slot present, "—" where the
 *  QoS sets nothing, so a missing GPU cap is visibly missing. */
function capCells(cap: DynamicPartitionCap | undefined, t: TFn): string[] {
  if (!cap) return ["—"];
  const cores = cap.maxCores
    ? cap.minCores ? `${nf(cap.minCores)}–${nf(cap.maxCores)}c` : `${nf(cap.maxCores)}c`
    : "—";
  const mem = fmtCapMem(cap.maxMemGb) || "—";
  const gpu = cap.maxGpus ? `${cap.maxGpus} GPU` : "—";
  const nodes = cap.maxNodes ? `${nf(cap.maxNodes)} ${t(cap.maxNodes === 1 ? "spec.nodeSingle" : "spec.nodes")}` : "—";
  return [cores, mem, gpu, nodes, cap.wall ?? "—"];
}

function defaultRequestText(d: PartitionDefaults, t: TFn): string {
  if (!d.cores) return "—";
  if (!d.def_mem_per_cpu_mb) return t("guide.policy.defaultReqCores", { cores: d.cores });
  const mem = fmtMB(d.def_mem_per_cpu_mb * d.cores);
  return d.gpus_per_node
    ? t("guide.policy.defaultReqGpu", { cores: d.cores, mem, gpus: d.gpus_per_node })
    : t("guide.policy.defaultReq", { cores: d.cores, mem });
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
  const rows = useMemo(() => (policy ? buildRows(policy, snap) : []), [policy, snap]);
  const check: PolicyCheckReport | null = data?.check ?? null;
  const lua = data?.lua ?? policy?.lua;
  const versions: LuaVersion[] = lua?.versions ?? [];

  if (!policy && !data) {
    return (
      <SectionCard title={t("guide.policy.title")}>
        {loading ? <ChartPlaceholder className="h-24" /> : <Empty>{t("guide.policy.noData")}</Empty>}
      </SectionCard>
    );
  }

  // ---- header facts: when read, when verified, with what result --------------
  const checkedAt = check?.checked_at ?? policy?.check?.checked_at;
  const badParts = check?.partitions
    ? Object.entries(check.partitions).filter(([, v]) => v.ok === false).map(([k]) => k)
    : policy?.check?.mismatches ?? [];
  const checkLine = !checkedAt
    ? t("guide.policy.checkedNone")
    : badParts.length
      ? t("guide.policy.checkedBad", { time: fmtDateTime(checkedAt), parts: badParts.join(", ") })
      : t("guide.policy.checkedOk", { time: fmtDateTime(checkedAt) });

  // ---- findings, each only when its condition holds in the data --------------
  const luaFacts = lua?.partitions ?? policy?.lua?.partitions ?? {};
  const overwritten = rows.filter((r) => r.defaults.gpu_request_respected === false).map((r) => r.name);
  const checkedFields = [...new Set(overwritten.flatMap((p) => luaFacts[p]?.gpu_request_fields ?? []))];
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
  if (overwritten.length) {
    findings.push({
      key: "gpu",
      tone: "warn",
      text: t("guide.policy.find.gpuOverwritten", {
        parts: overwritten.join(", "),
        fields: checkedFields.length ? checkedFields.map((f) => `job_desc.${f}`).join(", ") : "—",
      }),
    });
  }
  if (noGpuCap.length) {
    findings.push({ key: "nogpucap", tone: "info", text: t("guide.policy.find.noGpuCap", { parts: noGpuCap.join(", ") }) });
  }
  if (luaMemIgnored.length) {
    findings.push({ key: "luamem", tone: "info", text: t("guide.policy.find.luaMem", { parts: luaMemIgnored.join(", ") }) });
  }

  const grouped = GROUP_ORDER.map((g) => ({ group: g, rows: rows.filter((r) => r.group === g) })).filter((g) => g.rows.length);
  const luaMeta = [lua?.path, lua?.sha ? `sha ${lua.sha}` : ""].filter(Boolean).join(" · ");

  return (
    <SectionCard title={t("guide.policy.title")}>
      <div className="space-y-4">
        {/* 1. what these texts are and how the dashboard uses them */}
        <div className="space-y-1.5 text-sm text-muted-foreground">
          {(["guide.policy.intro.lua", "guide.policy.intro.qos", "guide.policy.intro.how"] as TranslationKey[]).map((key) => (
            <p key={key} className="rounded-md bg-muted/30 px-2.5 py-1.5">{t(key)}</p>
          ))}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 font-mono text-xs">
            {data?.fetched_at ? <span>{t("guide.policy.fetchedAt", { time: fmtDateTime(data.fetched_at) })}</span> : null}
            <span className={badParts.length ? "text-bad-fg" : checkedAt ? "text-ok-fg" : ""}>{checkLine}</span>
          </div>
        </div>

        {/* 2. per-partition reading */}
        {rows.length > 0 && (
          <div>
            <SubTitle>{t("guide.policy.tableTitle")}</SubTitle>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem] text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">{t("guide.policy.col.partition")}</th>
                    <th className="py-1.5 pr-3 font-medium">{t("guide.policy.col.caps")}</th>
                    <th className="py-1.5 pr-3 font-medium">{t("guide.policy.col.concurrency")}</th>
                    <th className="py-1.5 pr-3 font-medium">{t("guide.policy.col.default")}</th>
                    <th className="py-1.5 pr-3 font-medium">{t("guide.policy.col.interactive")}</th>
                    <th className="py-1.5 pr-3 font-medium">{t("guide.policy.col.gpuReq")}</th>
                    <th className="py-1.5 font-medium">{t("guide.policy.col.verified")}</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.map(({ group, rows: groupRows }) => (
                    <GroupRows key={group} group={group} rows={groupRows} check={check} t={t} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 3. findings derived from the data */}
        {findings.length > 0 && (
          <div>
            <SubTitle>{t("guide.policy.findingsTitle")}</SubTitle>
            <div className="space-y-1.5">
              {findings.map((f) => <Callout key={f.key} tone={f.tone}>{f.text}</Callout>)}
            </div>
          </div>
        )}

        {/* 4. job_submit.lua change history */}
        {versions.length > 0 && (
          <div>
            <SubTitle>{t("guide.policy.historyTitle")}</SubTitle>
            <p className="mb-1.5 text-xs text-muted-foreground">{t("guide.policy.historyNote")}</p>
            <ul className="space-y-1">
              {versions.map((v) => (
                <li key={v.name} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md bg-muted/30 px-2.5 py-1.5 font-mono text-xs">
                  <span className="font-semibold">{v.name}</span>
                  {v.current && <Tag tone="ok">{t("guide.policy.current")}</Tag>}
                  <span className="text-muted-foreground">{fmtDateTime(v.mtime)}</span>
                  <span className="ml-auto text-muted-foreground">{(v.size / 1024).toFixed(1)} KB</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 5. the raw texts, closed by default */}
        {data && (data.lua_text || data.qos_text || data.partitions_text || data.check) && (
          <div>
            <SubTitle>{t("guide.policy.rawTitle")}</SubTitle>
            <div className="space-y-2">
              {data.lua_text && <RawBlock title="job_submit.lua" meta={luaMeta || undefined} text={data.lua_text} />}
              {data.qos_text && <RawBlock title={t("guide.policy.raw.qos")} text={data.qos_text} />}
              {data.partitions_text && <RawBlock title={t("guide.policy.raw.partitions")} text={data.partitions_text} />}
              {data.check && <RawBlock title={t("guide.policy.raw.check")} text={JSON.stringify(data.check, null, 2)} />}
            </div>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function SubTitle({ children }: { children: ReactNode }) {
  return <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</div>;
}

function GroupRows({ group, rows, check, t }: { group: Group; rows: Row[]; check: PolicyCheckReport | null; t: TFn }) {
  return (
    <>
      <tr className="border-b border-border/50 bg-muted/20">
        <td colSpan={7} className="py-1 pr-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t(`guide.policy.group.${group}` as TranslationKey)}
        </td>
      </tr>
      {rows.map((r) => <PartitionRow key={r.name} row={r} check={check} t={t} />)}
    </>
  );
}

function PartitionRow({ row, check, t }: { row: Row; check: PolicyCheckReport | null; t: TFn }) {
  const { name, cap, policy, defaults: d } = row;
  const caps = capCells(cap, t);
  const concurrency = [
    policy.maxJobsPerUser ? t("guide.policy.perUserRun", { n: policy.maxJobsPerUser }) : "",
    policy.maxSubmitPerUser ? t("guide.policy.perUserSubmit", { n: policy.maxSubmitPerUser }) : "",
    policy.grpJobs ? t("guide.policy.groupJobs", { n: policy.grpJobs }) : "",
  ].filter(Boolean);
  const interactive = Object.keys(d).length === 0
    ? "—"
    : d.interactive_time_min
      ? t("guide.policy.forced", { t: fmtWallMinutes(d.interactive_time_min) })
      : t("guide.policy.honoursT");
  const gpuReq = !d.gpus_per_node
    ? "—"
    : d.gpu_request_respected === false
      ? t("guide.policy.gpuRespectedNo", { n: d.gpus_per_node })
      : t("guide.policy.gpuRespectedYes");
  const verified = check?.partitions?.[name];
  const skipped = check?.skipped?.[name];
  return (
    <tr className="border-b border-border/50 align-top">
      <td className="py-1.5 pr-3 font-mono font-semibold">
        <div className="flex flex-wrap items-center gap-1">
          {name}
          {d.requires_license && <Tag tone="neutral">{t("guide.policy.license")}</Tag>}
        </div>
      </td>
      <td className="whitespace-nowrap py-1.5 pr-3 font-mono tabular-nums text-muted-foreground">{caps.join(" / ")}</td>
      <td className="py-1.5 pr-3 text-muted-foreground">{concurrency.length ? concurrency.join(" · ") : "—"}</td>
      <td className="whitespace-nowrap py-1.5 pr-3 font-mono tabular-nums">{defaultRequestText(d, t)}</td>
      <td className="whitespace-nowrap py-1.5 pr-3">{interactive}</td>
      <td className="py-1.5 pr-3">
        {d.gpus_per_node && d.gpu_request_respected === false ? <span className="text-warn-fg">{gpuReq}</span> : gpuReq}
      </td>
      <td className="py-1.5" title={verified?.diffs?.length ? verified.diffs.join("\n") : undefined}>
        {verified
          ? <span className={cn("font-semibold", verified.ok ? "text-ok-fg" : "text-bad-fg")}>{verified.ok ? "✓" : "✗"}</span>
          : skipped
            ? <span className="text-muted-foreground">{t("guide.policy.verifiedSkipped", { reason: skipped })}</span>
            : "—"}
      </td>
    </tr>
  );
}
