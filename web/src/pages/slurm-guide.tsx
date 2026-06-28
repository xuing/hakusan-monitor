import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { Tag } from "@/components/common/tag";
import { Button } from "@/components/ui/button";
import { useT, type TFn, type TranslationKey } from "@/i18n";
import type { Tone } from "@/lib/slurm";

// Language-neutral data: the shell text and tone are the same in every language.
// All prose (titles, details, tips) lives in i18n under guide.* — see en.ts.
interface Command {
  key: string; // -> guide.cmd.<key>.{title,detail}
  command: string;
  tone?: Tone;
}

const COMMANDS: Command[] = [
  { key: "myqueue", command: 'squeue -u "$USER" -o "%.18i %.9P %.8T %.10M %.9l %.6D %R"', tone: "info" },
  { key: "policy", command: "spart", tone: "info" },
  { key: "sinfo", command: 'sinfo -o "%P %a %l %D %t %N"', tone: "info" },
  { key: "cpu", command: "salloc -p TINY -c 2", tone: "ok" },
  { key: "gpu", command: "salloc -p GPU-1 -c 2 -G 1", tone: "ok" },
  { key: "srun", command: "srun -p SMALL -n 1 -c 16 --mem=64G bash run.sh", tone: "neutral" },
  { key: "sbatch", command: "sbatch job.sh", tone: "neutral" },
  {
    key: "batchtpl",
    command:
      "#!/bin/bash\n#SBATCH -J myjob\n#SBATCH -p SMALL\n#SBATCH -N 1\n#SBATCH -n 1\n#SBATCH -c 16\n#SBATCH --mem=64G\n#SBATCH -t 02:00:00\n#SBATCH -o %x_%j.log\n#SBATCH -e %x_%j.log\n\nsource /etc/profile.d/modules.sh\ncd ${SLURM_SUBMIT_DIR}\nbash run.sh",
    tone: "neutral",
  },
  {
    key: "gputpl",
    command:
      "#!/bin/bash\n#SBATCH -J gpujob\n#SBATCH -p GPU-1\n#SBATCH -N 1\n#SBATCH -n 1\n#SBATCH -c 8\n#SBATCH --gres=gpu:nvidia_a40:1\n#SBATCH --mem=48G\n#SBATCH -o %x_%j.log\n#SBATCH -e %x_%j.log\n\nsource /etc/profile.d/modules.sh\nmodule load singularity/3.9.5\ncd ${SLURM_SUBMIT_DIR}\nsingularity exec --nv /app/container_images/tensorflow_2.20.0.sif python train.py",
    tone: "neutral",
  },
  { key: "sacct", command: "sacct -j <job_id> --format=JobID,JobName,State,Elapsed,MaxRSS,ExitCode", tone: "info" },
  { key: "scancel", command: "scancel <job_id>", tone: "warn" },
  {
    key: "singularity",
    command: "module load singularity/3.9.5\nsingularity exec --nv image.sif python train.py",
    tone: "neutral",
  },
];

const FLOW: TranslationKey[] = ["guide.flow.1", "guide.flow.2", "guide.flow.3", "guide.flow.4"];
const PARTS: TranslationKey[] = ["guide.part.1", "guide.part.2", "guide.part.3", "guide.part.4", "guide.part.5"];
const ETIQ: TranslationKey[] = ["guide.etiq.1", "guide.etiq.2", "guide.etiq.3", "guide.etiq.4"];

const REFS: [string, string][] = [
  ["Hakusan seminar 2026-04-09", "https://jstorage.app.box.com/v/hakusan20260409ja"],
  ["MPC orientation 2026-06", "https://jstorage.app.box.com/v/mpcorientation202606-ja"],
  ["Hakusan seminar 2026-06-18", "https://jstorage.app.box.com/v/hakusan20260618ja"],
  ["Slurm Quick Start", "https://slurm.schedmd.com/quickstart.html"],
  ["squeue", "https://slurm.schedmd.com/squeue.html"],
  ["srun", "https://slurm.schedmd.com/srun.html"],
  ["sbatch", "https://slurm.schedmd.com/sbatch.html"],
  ["sacct", "https://slurm.schedmd.com/sacct.html"],
];

export default function SlurmGuidePage() {
  const t = useT();

  return (
    <div className="space-y-4">
      <SectionCard title={t("guide.title")}>
        <p className="max-w-4xl text-sm text-muted-foreground">{t("guide.lead")}</p>
      </SectionCard>

      <SectionCard title={t("guide.workflowTitle")}>
        <div className="grid gap-2 md:grid-cols-2">
          {FLOW.map((key, i) => (
            <div key={key} className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
              <span className="mr-2 font-mono text-xs text-info-fg">{i + 1}</span>
              {t(key)}
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title={t("guide.partitionTitle")}>
        <div className="grid gap-2 md:grid-cols-2">
          {PARTS.map((key) => (
            <div key={key} className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              {t(key)}
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title={t("guide.commandsTitle")}>
        <div className="grid gap-3 lg:grid-cols-2">
          {COMMANDS.map((cmd) => (
            <CommandCard key={cmd.key} item={cmd} t={t} />
          ))}
        </div>
      </SectionCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title={t("guide.etiquetteTitle")}>
          <ul className="space-y-2 text-sm text-muted-foreground">
            {ETIQ.map((key) => (
              <li key={key} className="rounded-lg bg-muted/30 px-3 py-2">{t(key)}</li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard title={t("guide.refsTitle")}>
          <div className="space-y-2">
            {REFS.map(([label, href]) => (
              <a
                key={href}
                href={href}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
              >
                {label}
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ))}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

function CommandCard({ item, t }: { item: Command; t: TFn }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(item.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold">{t(`guide.cmd.${item.key}.title` as TranslationKey)}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t(`guide.cmd.${item.key}.detail` as TranslationKey)}</p>
        </div>
        {item.tone && <Tag tone={item.tone}>{item.tone}</Tag>}
      </div>
      <pre className="max-h-48 overflow-auto rounded-md bg-background p-3 font-mono text-xs text-foreground/90">
        {item.command}
      </pre>
      <div className="mt-2 flex justify-end">
        <Button variant="outline" size="sm" className="h-8 gap-1.5" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? t("helper.copied") : t("helper.copy")}
        </Button>
      </div>
    </div>
  );
}
