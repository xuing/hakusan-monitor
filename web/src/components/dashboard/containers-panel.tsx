import type { ReactNode } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useCopied } from "@/components/common/copy-button";
import { SectionCard } from "@/components/common/section-card";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/use-api";
import { useT, type TranslationKey } from "@/i18n";
import { api } from "@/lib/api";

const DOCS_URL = "https://docs.sylabs.io/guides/4.3/user-guide/";

const WORKFLOW: TranslationKey[] = [
  "container.workflow.1",
  "container.workflow.2",
  "container.workflow.3",
  "container.workflow.4",
];

const NOTES: TranslationKey[] = [
  "container.note.sif",
  "container.note.cache",
  "container.note.gpu",
  "container.note.bind",
  "container.note.write",
  "container.note.env",
  "container.note.service",
];

const COMMANDS: { title: TranslationKey; detail: TranslationKey; command: string }[] = [
  {
    title: "container.cmd.pull.title",
    detail: "container.cmd.pull.detail",
    command: "singularity pull python_3.12.sif docker://python:3.12",
  },
  {
    title: "container.cmd.cache.title",
    detail: "container.cmd.cache.detail",
    command: "mkdir -p /path/to/scratch/singularity/{cache,tmp}\nexport SINGULARITY_CACHEDIR=/path/to/scratch/singularity/cache\nexport SINGULARITY_TMPDIR=/path/to/scratch/singularity/tmp",
  },
  {
    title: "container.cmd.cpu.title",
    detail: "container.cmd.cpu.detail",
    command: "cd \"$SLURM_SUBMIT_DIR\"\nsingularity exec image.sif python script.py",
  },
  {
    title: "container.cmd.gpu.title",
    detail: "container.cmd.gpu.detail",
    command: "cd \"$SLURM_SUBMIT_DIR\"\nsingularity exec --nv pytorch.sif python train.py",
  },
  {
    title: "container.cmd.run.title",
    detail: "container.cmd.run.detail",
    command: "singularity run image.sif",
  },
  {
    title: "container.cmd.shell.title",
    detail: "container.cmd.shell.detail",
    command: "salloc -p TINY\nsingularity shell image.sif",
  },
  {
    title: "container.cmd.bind.title",
    detail: "container.cmd.bind.detail",
    command: "singularity exec --bind /path/to/data:/data image.sif python train.py --data /data",
  },
  {
    title: "container.cmd.env.title",
    detail: "container.cmd.env.detail",
    command: "singularity exec --cleanenv --no-home --env PYTHONNOUSERSITE=1 image.sif python -c 'import sys; print(sys.path[:3])'",
  },
  {
    title: "container.cmd.service.title",
    detail: "container.cmd.service.detail",
    command: "# image must start the service from its runscript/startscript\nsingularity instance run --writable-tmpfs app.sif app\nsingularity instance list --logs\nsingularity instance stop app",
  },
];

export function ContainersPanel() {
  const { data } = useApi(api.meta, null, 60_000);
  const t = useT();
  const c = data?.container;

  return (
    <SectionCard
      title={t("section.containers")}
      className="min-w-0"
      extra={
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 hover:text-foreground"
        >
          {t("container.docs")}
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      }
    >
      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">{t("container.lead")}</p>

      {c && (
        <div className="mb-4 grid gap-2 rounded-lg border border-border bg-muted/20 p-3 text-sm sm:grid-cols-2">
          <Row k={t("container.runtime")}>
            <Code>{`${c.runtime} ${c.version}`}</Code>
          </Row>
          <Row k={t("container.command")}>
            <Code>{c.command || "singularity"}</Code>
          </Row>
        </div>
      )}

      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("container.workflowTitle")}</div>
      <div className="mb-4 grid gap-2 md:grid-cols-2">
        {WORKFLOW.map((key, i) => (
          <div key={key} className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
            <span className="mr-2 font-mono text-xs text-info-fg">{i + 1}</span>
            {t(key)}
          </div>
        ))}
      </div>

      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("container.examples")}</div>
      <div className="grid items-start gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {COMMANDS.map((item) => (
          <CommandCard key={item.title} title={t(item.title)} detail={t(item.detail)} command={item.command} />
        ))}
      </div>

      <GuideList title={t("container.gotchas")} keys={NOTES} className="mt-4" />
    </SectionCard>
  );
}

const Row = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className="flex min-w-0 items-baseline gap-2">
    <span className="shrink-0 text-muted-foreground">{k}</span>
    {children}
  </div>
);
const Code = ({ children }: { children: ReactNode }) => (
  <code className="min-w-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">{children}</code>
);

function GuideList({ title, keys, className = "" }: { title: string; keys: TranslationKey[]; className?: string }) {
  const t = useT();
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      <ul className="grid gap-1.5 text-sm text-muted-foreground">
        {keys.map((key) => (
          <li key={key} className="rounded-md bg-muted/30 px-3 py-2">
            {t(key)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CommandCard({ title, detail, command }: { title: string; detail: string; command: string }) {
  const t = useT();
  const [copied, copy] = useCopied();

  return (
    <div className="min-w-0 rounded-lg border border-border bg-background">
      <div className="flex items-start justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 gap-1.5"
          onClick={() => void copy(command)}
          title={t(copied ? "helper.copied" : "helper.copy")}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? t("helper.copied") : t("helper.copy")}
        </Button>
      </div>
      <pre className="max-w-full overflow-x-auto whitespace-pre-wrap break-all p-3 font-mono text-xs leading-relaxed text-foreground/90">
        {command}
      </pre>
    </div>
  );
}
