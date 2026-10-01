import { useState } from "react";
import { ChevronRight, ExternalLink } from "lucide-react";
import { ChartPlaceholder } from "@/components/common/chart-placeholder";
import { Empty } from "@/components/common/empty";
import { PolicySourceSection } from "@/components/guide/policy-source";
import { SectionCard } from "@/components/common/section-card";
import { useApi } from "@/hooks/use-api";
import { useT, type TranslationKey } from "@/i18n";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const PROJECT_URL = "https://github.com/xuing/hakusan-monitor";
const SLURM_POLL_COMMAND =
  "# realtime snapshot: HM_SAMPLE_INTERVAL\n" +
  "scontrol -o show nodes\n" +
  "squeue -h -a -o '<compact fields>'\n" +
  "# effective per-job mem/GPU + planned node + container; best effort\n" +
  "squeue -h -a -O 'JobID:64,tres-alloc:256,SchedNodes:128,Container:512'\n" +
  "# pending jobs' true requested totals (squeue %m prints per-CPU memory)\n" +
  "sacct -aX --state=PENDING -o JobID,ReqTRES -P -n\n" +
  "# CPU prediction: HM_CPU_PROBE_INTERVAL; no job submitted.\n" +
  "# -t = the interactive walltime job_submit.lua pins on that partition\n" +
  "#      (read from the Lua; omitted where the partition honours -t)\n" +
  "for p in TINY DEF SINGLE SMALL LARGE XLARGE X2LARGE LONG LONG-L; do\n" +
  '  sbatch --test-only -p "$p" ${LUA_T[$p]:+-t ${LUA_T[$p]}} --wrap=hostname\n' +
  "done\n" +
  "# static policy: HM_POLICY_INTERVAL\n" +
  "sacctmgr -n -P show qos format=Name,MaxTRES%200,MaxWall,GrpJobs,MaxJobsPU,MaxSubmitPU,MinTRES%200,Flags%100\n" +
  "scontrol -o show partition\n" +
  "# submit plugin (job_submit.lua) and when it last changed\n" +
  "cat /app/slurm/job_submit.lua\n" +
  "stat -c '%Y|%s|%n' /app/slurm/job_submit.lua /app/slurm/job_submit.lua_*\n" +
  "# container runtime; first successful sample only\n" +
  "singularity --version";
const LOGIN_POLL_COMMAND =
  "export LC_ALL=C\n" +
  "hostname\n" +
  "cat /proc/loadavg\n" +
  "nproc\n" +
  "grep '^cpu ' /proc/stat  # before iostat\n" +
  "cat /proc/meminfo\n" +
  "df -P -B1 -x tmpfs -x devtmpfs\n" +
  "df -Pi -x tmpfs -x devtmpfs\n" +
  "if command -v iostat >/dev/null 2>&1; then iostat -x -y 1 1; fi\n" +
  "grep '^cpu ' /proc/stat  # after iostat\n" +
  "ps -eo pid=,user=,stat=,pcpu=,pmem=,rss=,etimes=,comm=";

// what / cost are i18n keys; interval + env knob are language-neutral (the
// knob only shows on wide screens — on a phone it would push "cost" off-screen).
const CADENCE_ROWS: { what: TranslationKey; every: string; env: string; cost: TranslationKey }[] = [
  { what: "guide.project.cad.snap.what", every: "300 s", env: "HM_SAMPLE_INTERVAL", cost: "guide.project.cad.snap.cost" },
  { what: "guide.project.cad.probe.what", every: "900 s", env: "HM_CPU_PROBE_INTERVAL", cost: "guide.project.cad.probe.cost" },
  { what: "guide.project.cad.policy.what", every: "24 h", env: "HM_POLICY_INTERVAL", cost: "guide.project.cad.policy.cost" },
  { what: "guide.project.cad.login.what", every: "300 s", env: "HM_LOGIN_INTERVAL", cost: "guide.project.cad.login.cost" },
];

export default function ProjectGuidePage() {
  const t = useT();

  return (
    <div className="space-y-4">
      <VisitsCard />

      <SectionCard title={t("guide.projectTitle")}>
        <div className="space-y-3 text-sm">
          <RepoCard />
          {/* what is collected, how often, what it costs the login node — the
              "why it's light" facts are this table's footnote, not a card */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">{t("guide.project.cad.what")}</th>
                  <th className="py-1.5 pr-3 font-medium">{t("guide.project.cad.every")}</th>
                  <th className="py-1.5 font-medium">{t("guide.project.cad.cost")}</th>
                </tr>
              </thead>
              <tbody>
                {CADENCE_ROWS.map((row) => (
                  <tr key={row.what} className="border-b border-border/50 align-top last:border-0">
                    <td className="py-2 pr-3">{t(row.what)}</td>
                    <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-muted-foreground">
                      {row.every}<span className="hidden lg:inline"> · {row.env}</span>
                    </td>
                    <td className="py-2 text-muted-foreground">{t(row.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">{t("guide.project.lightNote")}</p>
          <details className="group rounded-lg border border-border">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
              {t("guide.project.commandsTitle")}
            </summary>
            <div className="grid gap-3 border-t border-border/60 p-3 lg:grid-cols-2">
              <CommandSnippet title={t("guide.project.slurmCommands")} text={SLURM_POLL_COMMAND} />
              <CommandSnippet title={t("guide.project.loginCommands")} text={LOGIN_POLL_COMMAND} />
            </div>
          </details>
        </div>
      </SectionCard>

      <PolicySourceSection />
    </div>
  );
}

function VisitsCard() {
  const t = useT();
  const { data, loading } = useApi(() => api.visits(30), null, 300_000);

  return (
    <SectionCard title={t("guide.visits.title")}>
      {!data && loading ? (
        <ChartPlaceholder className="h-48" />
      ) : !data ? (
        <Empty>{t("common.fetchError")}</Empty>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            <VisitStat
              label={t("guide.visits.today")}
              value={data.today.visitors}
              sub={t("guide.visits.hitsSub", { n: data.today.hits.toLocaleString() })}
              accent
            />
            <VisitStat
              label={t("guide.visits.window")}
              value={data.window.visitors}
              sub={t("guide.visits.hitsSub", { n: data.window.hits.toLocaleString() })}
            />
            <VisitStat
              label={t("guide.visits.totalHits")}
              value={data.total.hits}
              // non-breaking hyphens: a narrow tile must not split the date
              sub={data.total.since ? t("guide.visits.since", { date: data.total.since.replace(/-/g, "\u2011") }) : ""}
            />
          </div>
          {data.total.hits === 0 ? (
            <Empty>{t("guide.visits.nodata")}</Empty>
          ) : (
            <VisitsChart daily={data.daily} />
          )}
          <p className="text-xs text-muted-foreground/80">{t("guide.visits.note")}</p>
        </div>
      )}
    </SectionCard>
  );
}

/** Daily visitors, last 30 days. One series, so no legend — the caption
 *  names it. Bars sit on the baseline with rounded tops and a 2px gap; the
 *  whole column is the hover target and shows date · visitors · views. */
function VisitsChart({ daily }: { daily: { day: string; visitors: number; hits: number }[] }) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(0, ...daily.map((d) => d.visitors)));
  const ticks = [max, max / 2, 0];
  const mid = Math.floor((daily.length - 1) / 2);
  const shown = hover ?? daily.length - 1;
  const focus = daily[shown];
  return (
    <figure className="space-y-1.5">
      <figcaption className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-muted-foreground">{t("guide.visits.daily")}</span>
        {focus && (
          <span className="font-mono tabular-nums text-muted-foreground">
            <span className="text-foreground">{focus.day.slice(5)}</span>{" "}
            {t("guide.visits.tip", { v: focus.visitors, h: focus.hits })}
          </span>
        )}
      </figcaption>
      <div className="flex gap-2">
        {/* y axis: three recessive ticks */}
        <div className="flex h-36 flex-col justify-between py-px text-right font-mono text-xs leading-none text-muted-foreground/70">
          {ticks.map((v) => <span key={v}>{Math.round(v)}</span>)}
        </div>
        <div className="relative h-36 flex-1" onMouseLeave={() => setHover(null)}>
          {ticks.map((v) => (
            <div
              key={v}
              className="pointer-events-none absolute inset-x-0 border-t border-border/60"
              style={{ top: `${(1 - v / max) * 100}%` }}
            />
          ))}
          <div className="absolute inset-0 flex items-end gap-[2px]">
            {daily.map((d, i) => (
              <button
                key={d.day}
                type="button"
                aria-label={`${d.day} ${t("guide.visits.tip", { v: d.visitors, h: d.hits })}`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onClick={() => setHover(i)}
                className="group flex h-full min-w-0 flex-1 items-end outline-none"
              >
                <span
                  className={cn(
                    "block w-full rounded-t-[4px] transition-colors",
                    i === shown ? "bg-info" : "bg-info/45 group-hover:bg-info/70",
                  )}
                  style={{ height: d.visitors > 0 ? `max(2px, ${(d.visitors / max) * 100}%)` : 0 }}
                />
              </button>
            ))}
          </div>
        </div>
      </div>
      {daily.length > 0 && (
        <div className="flex justify-between pl-6 font-mono text-xs text-muted-foreground/70">
          <span>{daily[0].day.slice(5)}</span>
          <span>{daily[mid].day.slice(5)}</span>
          <span>{daily[daily.length - 1].day.slice(5)}</span>
        </div>
      )}
    </figure>
  );
}

function niceMax(value: number) {
  if (value <= 2) return 2;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = magnitude / 2;
  return Math.ceil(value / step) * step;
}

function VisitStat({ label, value, sub, accent }: { label: string; value: number; sub?: string; accent?: boolean }) {
  return (
    <div className={cn("min-w-0 rounded-lg border px-2.5 py-2 sm:px-3 sm:py-2.5", accent ? "border-info/40 bg-info-soft/40" : "border-border")}>
      <div className="text-xs leading-tight text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-xl font-semibold leading-tight tabular-nums sm:text-2xl">{value.toLocaleString()}</div>
      {sub && <div className="mt-0.5 text-xs leading-tight text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** The repository, as a card: mark, name, one line on what's there. */
function RepoCard() {
  const t = useT();
  const repo = PROJECT_URL.replace("https://github.com/", "");
  return (
    <a
      href={PROJECT_URL}
      target="_blank"
      rel="noreferrer"
      className="group flex items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 py-3 transition-colors hover:border-foreground/30 hover:bg-muted/40"
    >
      <GithubMark className="h-8 w-8 shrink-0 text-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-sm font-semibold text-foreground">{repo}</div>
        <div className="text-xs leading-relaxed text-muted-foreground">{t("guide.project.repoDesc")}</div>
      </div>
      <span className="hidden shrink-0 items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground transition-colors group-hover:text-foreground sm:inline-flex">
        {t("guide.project.repoOpen")}
        <ExternalLink className="h-3 w-3" />
      </span>
    </a>
  );
}

/** GitHub's mark (lucide dropped brand icons). */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function CommandSnippet({ title, text }: { title: string; text: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
      <pre className="max-h-56 overflow-auto rounded-md bg-background p-3 font-mono text-xs text-foreground/90">
        {text}
      </pre>
    </div>
  );
}
