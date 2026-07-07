import { BarChart } from "@tremor/react";
import { ExternalLink } from "lucide-react";
import { ChartPlaceholder } from "@/components/common/chart-placeholder";
import { Empty } from "@/components/common/empty";
import { SectionCard } from "@/components/common/section-card";
import { useApi } from "@/hooks/use-api";
import { useT, type TranslationKey } from "@/i18n";
import { api } from "@/lib/api";

const PROJECT_POLLING: TranslationKey[] = [
  "guide.project.poll.1",
  "guide.project.poll.2",
  "guide.project.poll.3",
  "guide.project.poll.4",
];
const PROJECT_LIGHT: TranslationKey[] = [
  "guide.project.light.1",
  "guide.project.light.2",
  "guide.project.light.3",
  "guide.project.light.4",
];
const PROJECT_URL = "https://github.com/xuing/hakusan-monitor";
const SLURM_POLL_COMMAND =
  "# realtime snapshot: HM_SAMPLE_INTERVAL\n" +
  "scontrol -o show nodes\n" +
  "squeue -h -a -o '<compact fields>'\n" +
  "# effective per-job mem/GPU + container; best effort\n" +
  "squeue -h -a -O 'JobID:64,tres-alloc:256,Container:512'\n" +
  "# CPU prediction: HM_CPU_PROBE_INTERVAL; no job submitted\n" +
  "for p in TINY DEF SINGLE SMALL LARGE XLARGE X2LARGE LONG LONG-L; do\n" +
  "  sbatch --test-only -p \"$p\" --wrap=hostname\n" +
  "done\n" +
  "# static policy: HM_POLICY_INTERVAL\n" +
  "sacctmgr -n -P show qos format=Name,MaxTRES%200,MaxWall,GrpJobs,MaxJobsPU,MaxSubmitPU,MinTRES%200,Flags%100\n" +
  "scontrol -o show partition\n" +
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
  "if command -v iostat >/dev/null 2>&1; then iostat -x -y 1 1; fi\n" +
  "grep '^cpu ' /proc/stat  # after iostat\n" +
  "ps -eo pid=,user=,stat=,pcpu=,pmem=,rss=,etimes=,comm=";

// what / cost are i18n keys; `every` is language-neutral (interval + env knob).
const CADENCE_ROWS: { what: TranslationKey; every: string; cost: TranslationKey }[] = [
  { what: "guide.project.cad.snap.what", every: "300 s · HM_SAMPLE_INTERVAL", cost: "guide.project.cad.snap.cost" },
  { what: "guide.project.cad.probe.what", every: "900 s · HM_CPU_PROBE_INTERVAL", cost: "guide.project.cad.probe.cost" },
  { what: "guide.project.cad.policy.what", every: "24 h · HM_POLICY_INTERVAL", cost: "guide.project.cad.policy.cost" },
  { what: "guide.project.cad.login.what", every: "300 s · HM_LOGIN_INTERVAL", cost: "guide.project.cad.login.cost" },
  { what: "guide.project.cad.sing.what", every: "—", cost: "guide.project.cad.sing.cost" },
  { what: "guide.project.cad.sse.what", every: "—", cost: "guide.project.cad.sse.cost" },
];

export default function ProjectGuidePage() {
  const t = useT();

  return (
    <div className="space-y-4">
      <SectionCard title={t("guide.projectTitle")}>
        <div className="space-y-3 text-sm">
          <a
            href={PROJECT_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-muted-foreground hover:text-foreground"
          >
            <span className="font-mono text-xs">{PROJECT_URL}</span>
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <InfoList title={t("guide.project.pollTitle")} keys={PROJECT_POLLING} />
        </div>
      </SectionCard>

      <SectionCard title={t("guide.project.cadenceTitle")}>
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
                  <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-muted-foreground">{row.every}</td>
                  <td className="py-2 text-muted-foreground">{t(row.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title={t("guide.project.commandsTitle")}>
        <div className="grid gap-3 lg:grid-cols-2">
          <CommandSnippet title={t("guide.project.slurmCommands")} text={SLURM_POLL_COMMAND} />
          <CommandSnippet title={t("guide.project.loginCommands")} text={LOGIN_POLL_COMMAND} />
        </div>
      </SectionCard>

      <SectionCard title={t("guide.project.lightTitle")}>
        <InfoList keys={PROJECT_LIGHT} />
      </SectionCard>

      <VisitsCard />
    </div>
  );
}

function VisitsCard() {
  const t = useT();
  const { data, loading } = useApi(() => api.visits(30), null, 300_000);

  const daily = (data?.daily ?? []).map((d) => ({
    day: d.day.slice(5), // MM-DD
    [t("guide.visits.daily")]: d.visitors,
  }));

  return (
    <SectionCard title={t("guide.visits.title")} extra={t("guide.visits.note")}>
      {!data && loading ? (
        <ChartPlaceholder className="h-40" />
      ) : !data ? (
        <Empty>{t("common.fetchError")}</Empty>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <VisitStat label={t("guide.visits.today")} value={data.today.visitors} />
            <VisitStat label={t("guide.visits.window")} value={data.window.visitors} />
            <VisitStat label={t("guide.visits.totalHits")} value={data.total.hits} />
          </div>
          {data.total.hits === 0 ? (
            <Empty>{t("guide.visits.nodata")}</Empty>
          ) : (
            <BarChart
              data={daily}
              index="day"
              categories={[t("guide.visits.daily")]}
              colors={["blue"]}
              startEndOnly
              showLegend={false}
              yAxisWidth={32}
              className="h-40"
            />
          )}
        </div>
      )}
    </SectionCard>
  );
}

function VisitStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-xl font-semibold tabular-nums">{value.toLocaleString()}</div>
    </div>
  );
}

function InfoList({ title, keys }: { title?: string; keys: TranslationKey[] }) {
  const t = useT();
  return (
    <div>
      {title && <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</div>}
      <ul className="space-y-1.5 text-sm text-muted-foreground">
        {keys.map((key) => (
          <li key={key} className="rounded-md bg-muted/30 px-2.5 py-1.5">{t(key)}</li>
        ))}
      </ul>
    </div>
  );
}

function CommandSnippet({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">{title}</div>
      <pre className="max-h-56 overflow-auto rounded-md bg-background p-3 font-mono text-[11px] text-foreground/90">
        {text}
      </pre>
    </div>
  );
}
