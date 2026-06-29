import { ExternalLink } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { useT, type TranslationKey } from "@/i18n";

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
  "scontrol -o show nodes\n" +
  "squeue -h -a -o '<compact fields>'\n" +
  "squeue -h -a -O 'JobID:64,Container:512'\n" +
  "for p in TINY DEF SINGLE SMALL LARGE XLARGE X2LARGE LONG LONG-L; do\n" +
  "  sbatch --test-only -p \"$p\" --wrap=hostname\n" +
  "done\n" +
  "singularity --version  # first sample only";
const LOGIN_POLL_COMMAND =
  "export LC_ALL=C\n" +
  "hostname\n" +
  "cat /proc/loadavg\n" +
  "nproc\n" +
  "grep '^cpu ' /proc/stat\n" +
  "cat /proc/meminfo\n" +
  "df -P -B1 -x tmpfs -x devtmpfs\n" +
  "df -P -i -x tmpfs -x devtmpfs\n" +
  "if command -v iostat >/dev/null 2>&1; then iostat -x -y 1 1; fi\n" +
  "ps -eo pid=,user=,stat=,pcpu=,pmem=,rss=,etimes=,comm=";

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

      <SectionCard title={t("guide.project.commandsTitle")}>
        <div className="grid gap-3 lg:grid-cols-2">
          <CommandSnippet title={t("guide.project.slurmCommands")} text={SLURM_POLL_COMMAND} />
          <CommandSnippet title={t("guide.project.loginCommands")} text={LOGIN_POLL_COMMAND} />
        </div>
      </SectionCard>

      <SectionCard title={t("guide.project.lightTitle")}>
        <InfoList keys={PROJECT_LIGHT} />
      </SectionCard>
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
