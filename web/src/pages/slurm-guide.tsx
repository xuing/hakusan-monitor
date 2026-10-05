// Slurm guide: the common path first (salloc -> sbatch -> check/cancel), then
// partition choice and house rules; rare needs live in collapsed cards under
// 进阶. Every limit, default and walltime shown here is read from the live
// snapshot — when the policy is missing the sentence carrying it is omitted.
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { AlertTriangle, ChevronRight, Clock, ExternalLink, Info, MemoryStick } from "lucide-react";
import { SectionCard } from "@/components/common/section-card";
import { CopyButton } from "@/components/common/copy-button";
import { useLive } from "@/hooks/live-context";
import { useT, type TFn, type TranslationKey } from "@/i18n";
import { fmtMB } from "@/lib/format";
import { maxJobGpus } from "@/lib/gpu-layout";
import {
  allowsMultiNode,
  interactiveForcedLabel,
  partitionCap,
  partitionDefaults,
  partitionDisplayRank,
  partitionPolicy,
  type Tone,
} from "@/lib/slurm";
import { cn } from "@/lib/utils";
import type { Partition, Snapshot } from "@/types/snapshot";

// ---- language-neutral example text -------------------------------------------
type Kind = "cpu" | "gpu";

// the partitions the examples submit to — names only, every number is live
const EXAMPLE_PARTITION: Record<Kind, string> = { cpu: "DEF", gpu: "GPU-1" };

const SALLOC: Record<Kind, string> = { cpu: "salloc -p DEF -n 1 -c 8", gpu: "salloc -p GPU-1" };

const SCRIPT: Record<Kind, { cores: number; text: string }> = {
  cpu: {
    cores: 16,
    text: "#!/bin/bash\n#SBATCH -J myjob\n#SBATCH -p DEF\n#SBATCH -n 1\n#SBATCH -c 16\n#SBATCH -t 02:00:00\n#SBATCH -o %x_%j.log\n\nbash run.sh",
  },
  gpu: {
    cores: 8,
    text: "#!/bin/bash\n#SBATCH -J gpujob\n#SBATCH -p GPU-1\n#SBATCH -n 1\n#SBATCH -c 8\n#SBATCH -t 02:00:00\n#SBATCH -o %x_%j.log\n\nsingularity exec --nv image.sif python train.py",
  },
};

const MANAGE: { key: string; command: string }[] = [
  { key: "queue", command: "squeue -u $USER" },
  { key: "log", command: "tail -f myjob_<job_id>.log" },
  { key: "cancel", command: "scancel <job_id>" },
  { key: "sacct", command: "sacct -j <job_id> --format=JobID,JobName,State,Elapsed,MaxRSS,ExitCode" },
  { key: "spart", command: "spart" },
];

// the everyday partitions the chooser lists; the rest is on the Partitions page
const COMMON_PARTITIONS = ["TINY", "DEF", "SINGLE", "LONG", "GPU-1", "GPU-1A"];

const TASK_LAYOUTS: { key: string; flags: string }[] = [
  { key: "thread", flags: "-n 1 -c 16" },
  { key: "mpi", flags: "-n 64" },
  { key: "hybrid", flags: "-n 8 -c 8" },
];

const CONTAINER_PULL = "singularity pull image.sif docker://<image>:<tag>";
const CONTAINER_RUN = "singularity exec --nv image.sif python train.py";

const ARRAY_SCRIPT =
  "#!/bin/bash\n#SBATCH -J sweep\n#SBATCH -p DEF\n#SBATCH -n 1\n#SBATCH -c 4\n#SBATCH -t 01:00:00\n#SBATCH --array=1-10\n#SBATCH -o %x_%A_%a.log\n\npython run.py --seed $SLURM_ARRAY_TASK_ID";

// The pseudo-interactive recipe: verified live on this cluster (the
// quick-request hint links here as /slurm#pty). Keep the text exact.
const PTY_STEPS: { key: "1" | "2" | "3"; command: string }[] = [
  { key: "1", command: "JOB=$(sbatch --parsable -p <partition> --mem=<mem> -t <time> --wrap 'sleep infinity')" },
  {
    key: "2",
    // srun errors with "Job is pending execution" if attached before the
    // placeholder starts — wait out the queue first (verified live)
    command:
      "while squeue -h -j $JOB -o %T | grep -qE 'PENDING|CONFIGURING'; do sleep 5; done\n"
      + "srun --jobid $JOB --overlap --pty bash",
  },
  { key: "3", command: "scancel $JOB" },
];

const REFS: [string, string][] = [
  ["Hakusan seminar 2026-04-09", "https://jstorage.app.box.com/v/hakusan20260409ja"],
  ["MPC orientation 2026-06", "https://jstorage.app.box.com/v/mpcorientation202606-ja"],
  ["Hakusan seminar 2026-06-18", "https://jstorage.app.box.com/v/hakusan20260618ja"],
  ["Slurm Quick Start", "https://slurm.schedmd.com/quickstart.html"],
  ["sbatch", "https://slurm.schedmd.com/sbatch.html"],
  ["salloc", "https://slurm.schedmd.com/salloc.html"],
  ["Job arrays", "https://slurm.schedmd.com/job_array.html"],
  ["Slurm Documentation", "https://slurm.schedmd.com/documentation.html"],
];

// ---- facts read from the snapshot --------------------------------------------
interface PartRow {
  name: string;
  wall?: string;
  maxCores?: number;
  gpus?: number;
  gpuLabel?: string;
  gpuMemGb?: number;
  perUser?: number;
}

interface Facts {
  /** forced interactive walltime per example partition ("2d", "12h") */
  forced: Partial<Record<Kind, string>>;
  /** DefMemPerCPU per example partition, formatted */
  memPerCore: Partial<Record<Kind, string>>;
  wall: Partial<Record<Kind, string>>;
  /** what a bare `salloc -p GPU-1` gets */
  gpuDefault?: { gpus: number; cores: number; label: string };
  /** the -c trap on DEF: tasks the plugin pins and the QoS core cap */
  nTrap?: { tasks: number; max: number };
  rows: PartRow[];
  multiNode: string[];
  /** GPU flags the plugin does not read as a GPU request (it then sets its
   *  default per node): --gpus when no partition checks tres_per_job, etc. */
  gpuIgnoredFlags: string[];
  multiGpu: { p: string; n: number }[];
  ptyForced: string;
  license: string[];
  arrayPerUser?: number;
}

function gpuOf(snap: Snapshot, p: Partition | undefined) {
  const pool = p ? snap.pools.find((x) => x.id === p.pool) : undefined;
  return pool?.gpu ? { label: pool.gpu.label, memGb: pool.gpu.mem_gb } : undefined;
}

function jobGpus(snap: Snapshot, p: Partition): number {
  const policy = snap.policy;
  const cap = partitionCap(p.name, policy);
  if (!p.spec?.gpu_per_node) return 0;
  const shape = { gpus: p.spec.gpu_per_node, cores: p.spec.cores_per_node, memMb: p.spec.mem_per_node, count: p.nodes };
  return maxJobGpus(cap, shape, allowsMultiNode(cap, shape.cores));
}

function readFacts(snap: Snapshot | null): Facts {
  const empty: Facts = { forced: {}, memPerCore: {}, wall: {}, rows: [], multiNode: [], gpuIgnoredFlags: [], multiGpu: [], ptyForced: "", license: [] };
  if (!snap?.policy) return empty;
  const policy = snap.policy;
  const byName = new Map(snap.partitions.map((p) => [p.name, p]));
  const facts = empty;

  for (const kind of ["cpu", "gpu"] as const) {
    const p = EXAMPLE_PARTITION[kind];
    const d = partitionDefaults(p, policy);
    facts.forced[kind] = interactiveForcedLabel(p, policy) ?? undefined;
    if (d.def_mem_per_cpu_mb) facts.memPerCore[kind] = fmtMB(d.def_mem_per_cpu_mb);
    facts.wall[kind] = partitionCap(p, policy).wall;
  }

  const g = partitionDefaults(EXAMPLE_PARTITION.gpu, policy);
  const gLabel = gpuOf(snap, byName.get(EXAMPLE_PARTITION.gpu))?.label;
  if (g.gpus_per_node && g.cores && gLabel) facts.gpuDefault = { gpus: g.gpus_per_node, cores: g.cores, label: gLabel };

  const defTasks = partitionDefaults(EXAMPLE_PARTITION.cpu, policy).tasks;
  const defMax = partitionCap(EXAMPLE_PARTITION.cpu, policy).maxCores;
  if (defTasks && defMax && defTasks * 8 > defMax) facts.nTrap = { tasks: defTasks, max: defMax };

  facts.rows = COMMON_PARTITIONS.flatMap((name): PartRow[] => {
    const p = byName.get(name);
    const cap = partitionCap(name, policy);
    if (!p || (!cap.wall && !cap.maxCores)) return [];
    const gpu = p.kind === "gpu" ? gpuOf(snap, p) : undefined;
    return [{
      name,
      wall: cap.wall,
      maxCores: cap.maxCores,
      gpus: p.kind === "gpu" ? jobGpus(snap, p) || undefined : undefined,
      gpuLabel: gpu?.label,
      gpuMemGb: gpu?.memGb ?? undefined,
      perUser: partitionPolicy(name, policy).maxJobsPerUser,
    }];
  });

  const sorted = [...snap.partitions].sort((a, b) => partitionDisplayRank(a.name) - partitionDisplayRank(b.name));
  facts.multiNode = sorted
    .filter((p) => p.kind === "cpu" && policy.partition_caps?.[p.name]
      && allowsMultiNode(partitionCap(p.name, policy), p.spec?.cores_per_node || undefined))
    .map((p) => p.name);

  const gpuParts = sorted.filter((p) => p.kind === "gpu");
  const luaGpu = gpuParts.map((p) => policy.lua?.partitions?.[p.name]?.gpu_request_fields).filter((f): f is string[] => !!f);
  facts.gpuIgnoredFlags = luaGpu.length
    ? ([["tres_per_job", "--gpus=N"], ["tres_per_task", "--gpus-per-task=N"]] as const)
        .filter(([field]) => luaGpu.every((f) => !f.includes(field))).map(([, flag]) => flag)
    : [];
  facts.multiGpu = gpuParts.map((p) => ({ p: p.name, n: jobGpus(snap, p) })).filter((x) => x.n > 1);

  const labels = new Set(gpuParts.map((p) => interactiveForcedLabel(p.name, policy)).filter((l): l is string => !!l));
  facts.ptyForced = [...labels].join(" / ");

  facts.license = sorted.filter((p) => partitionDefaults(p.name, policy).requires_license).map((p) => p.name);
  facts.arrayPerUser = partitionPolicy(EXAMPLE_PARTITION.cpu, policy).maxJobsPerUser;
  return facts;
}

// ---- deep links ----------------------------------------------------------------
/** Scroll to the #hash, opening any collapsed card that holds it — react-router
 *  doesn't scroll on navigation, and #pty lives inside a closed <details>. */
function revealHash() {
  const id = decodeURIComponent(window.location.hash.slice(1));
  const el = id ? document.getElementById(id) : null;
  if (!el) return;
  if (el instanceof HTMLDetailsElement) el.open = true;
  for (let d = el.parentElement?.closest("details"); d; d = d.parentElement?.closest("details")) d.open = true;
  el.scrollIntoView({ block: "start" });
}

// ---- page ------------------------------------------------------------------------
export default function SlurmGuidePage() {
  const t = useT();
  const { snap } = useLive();
  const [kind, setKind] = useState<Kind>("cpu");
  const facts = readFacts(snap);
  const hasSnap = !!snap;

  // once on mount and again when the snapshot lands (it changes the layout)
  useEffect(() => {
    revealHash();
  }, [hasSnap]);
  useEffect(() => {
    window.addEventListener("hashchange", revealHash);
    return () => window.removeEventListener("hashchange", revealHash);
  }, []);

  // "" between zh/ja sentences, " " in en
  const sp = t("guide.sentenceSep");
  const toggle = <KindToggle value={kind} onChange={setKind} t={t} />;

  return (
    <div className="space-y-4">
      {/* full-width card grid like the other pages. Wide screens: salloc and
          check/cancel in the left column beside the taller sbatch card,
          partitions across both; narrow screens keep the reading order. */}
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Section id="interactive" className="xl:col-start-1 xl:row-start-1" title={t("guide.s1.title")} lead={t("guide.s1.lead")} extra={toggle}>
          <Terminal lines={[SALLOC[kind]]} />
          {kind === "gpu" && facts.gpuDefault && (
            <p className="mt-2 text-sm text-muted-foreground">
              <Rich text={t("guide.s1.gpuDefault", { p: EXAMPLE_PARTITION.gpu, ...facts.gpuDefault })} />
            </p>
          )}
          <div className="mt-4 space-y-2">
            <Note tone="warn" icon={AlertTriangle}>
              <Rich text={t("guide.s1.nTrap")} />
              {facts.nTrap && (
                <>
                  {sp}
                  <Rich
                    text={t("guide.s1.nTrapExample", {
                      p: EXAMPLE_PARTITION.cpu,
                      tasks: facts.nTrap.tasks,
                      total: facts.nTrap.tasks * 8,
                      max: facts.nTrap.max,
                    })}
                  />
                </>
              )}
            </Note>
            {facts.forced[kind] && (
              <Note tone="info" icon={Clock}>
                <Rich text={t("guide.s1.forced", { p: EXAMPLE_PARTITION[kind], t: facts.forced[kind]! })} />
              </Note>
            )}
            <Note tone="neutral" icon={MemoryStick}>
              {facts.memPerCore[kind] && (
                <>
                  <Rich text={t("guide.s1.memDefault", { mem: facts.memPerCore[kind]! })} />{sp}
                </>
              )}
              <Rich text={t("guide.s1.memMore")} />{sp}
              <Link to="/" className="whitespace-nowrap text-info-fg hover:underline">{t("guide.s1.memLink")}</Link>
            </Note>
          </div>
        </Section>

        <Section id="batch" className="xl:col-start-2 xl:row-span-2 xl:row-start-1" title={t("guide.s2.title")} lead={t("guide.s2.lead")} extra={toggle}>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
            <Terminal file="job.sh" text={SCRIPT[kind].text} />
            <dl className="space-y-2.5 text-sm">
              <Flag flag="-J">{t("guide.s2.flag.J")}</Flag>
              <Flag flag="-p">{t("guide.s2.flag.p")}</Flag>
              <Flag flag={`-n 1 -c ${SCRIPT[kind].cores}`}>{t("guide.s2.flag.nc", { c: SCRIPT[kind].cores })}</Flag>
              <Flag flag="-t">
                <Rich
                  text={facts.wall[kind]
                    ? t("guide.s2.flag.t", { p: EXAMPLE_PARTITION[kind], wall: facts.wall[kind]! })
                    : t("guide.s2.flag.tNoData")}
                />
              </Flag>
              <Flag flag="-o">{t("guide.s2.flag.o")}</Flag>
              {kind === "gpu" && <Flag flag="--nv"><Rich text={t("guide.s2.flag.nv")} /></Flag>}
            </dl>
          </div>
          <div className="mt-4">
            <Terminal lines={["sbatch job.sh"]} output="Submitted batch job 123456" />
            <p className="mt-2 text-sm text-muted-foreground">{t("guide.s2.submit")}</p>
          </div>
        </Section>

        <Section id="manage" className="xl:col-start-1 xl:row-start-2" title={t("guide.s3.title")}>
          <div className="divide-y divide-border/60">
            {MANAGE.map((m) => (
              <div key={m.key} className="grid gap-x-4 gap-y-1.5 py-3 first:pt-0 last:pb-0 md:grid-cols-[13rem_minmax(0,1fr)]">
                <div>
                  <div className="text-sm font-medium">{t(`guide.s3.${m.key}` as TranslationKey)}</div>
                  <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    <Rich text={t(`guide.s3.${m.key}Note` as TranslationKey)} />
                  </div>
                </div>
                <Terminal lines={[m.command]} className="self-start" />
              </div>
            ))}
          </div>
        </Section>

        <Section id="partitions" className="xl:col-span-2" title={t("guide.s4.title")} lead={t("guide.s4.lead")}>
          {facts.rows.length > 0 ? (
            <ul className="divide-y divide-border/60 rounded-lg border border-border">
              {facts.rows.map((r) => <PartitionRow key={r.name} row={r} t={t} />)}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">—</p>
          )}
          <p className="mt-3 text-sm text-muted-foreground">
            {t("guide.s4.more")}{t("guide.sentenceSep")}
            <Link to="/partitions" className="whitespace-nowrap text-info-fg hover:underline">{t("guide.s4.moreLink")}</Link>
          </p>
        </Section>

      </div>

      <Section id="rules" title={t("guide.rules.title")}>
        <ul className="grid gap-x-6 gap-y-2.5 text-sm leading-relaxed md:grid-cols-2">
          {(["1", "2", "3", "4"] as const).map((k) => (
            <li key={k} className="flex gap-2.5">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-info" aria-hidden />
              <span><Rich text={t(`guide.rules.${k}` as TranslationKey)} /></span>
            </li>
          ))}
        </ul>
      </Section>

      <div id="advanced" className="scroll-mt-16 space-y-2">
        <h2 className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t("guide.adv.title")}</h2>
        <div className="grid items-start gap-2 lg:grid-cols-2">

          <Advanced id="containers" title={t("guide.adv.container.title")} hint={t("guide.adv.container.hint")}>
            <p><Rich text={t("guide.adv.container.pull")} /></p>
            <Terminal lines={[CONTAINER_PULL]} />
            <p><Rich text={t("guide.adv.container.run")} /></p>
            <Terminal lines={[CONTAINER_RUN]} />
          </Advanced>

          <Advanced id="tasks" title={t("guide.adv.tasks.title")} hint={t("guide.adv.tasks.hint")}>
            <ul className="divide-y divide-border/60 rounded-lg border border-border">
              {TASK_LAYOUTS.map((l) => (
                <li key={l.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
                  <span>{t(`guide.adv.tasks.${l.key}` as TranslationKey)}</span>
                  <code className="font-mono text-xs text-foreground">{l.flags}</code>
                </li>
              ))}
            </ul>
            <p>
              <Rich text={t("guide.adv.tasks.nodes")} />
              {facts.multiNode.length > 0 && <>{sp}{t("guide.adv.tasks.nodesParts", { parts: facts.multiNode.join(", ") })}</>}
            </p>
          </Advanced>

          <Advanced id="multi-gpu" title={t("guide.adv.gpu.title")} hint={t("guide.adv.gpu.hint")}>
            <p>
              <Rich text={t("guide.adv.gpu.respected")} />
              {facts.gpuIgnoredFlags.length > 0 && (
                <>{sp}<Rich text={t("guide.adv.gpu.ignored", { flags: facts.gpuIgnoredFlags.map((x) => `\`${x}\``).join(t("guide.listSep")) })} /></>
              )}
            </p>
            {facts.multiGpu.length > 0 && (
              <p>
                {t("guide.adv.gpu.max", {
                  list: facts.multiGpu.map((x) => t("guide.adv.gpu.maxItem", { p: x.p, n: x.n })).join(t("guide.listSep")),
                })}
              </p>
            )}
            <p>{t("guide.adv.gpu.more")}</p>
          </Advanced>

          <Advanced id="pty" title={t("guide.pty.title")} hint={t("guide.pty.hint")}>
            <p>{facts.ptyForced ? t("guide.pty.lead", { forced: facts.ptyForced }) : t("guide.pty.leadNoData")}</p>
            <ol className="space-y-4">
              {PTY_STEPS.map((s, i) => (
                <li key={s.key} className="flex gap-3">
                  <StepBadge n={i + 1} small />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="font-medium text-foreground">{t(`guide.pty.step${s.key}.title` as TranslationKey)}</div>
                    <Terminal lines={s.command.split("\n")} />
                    <p className="text-xs leading-relaxed"><Rich text={t(`guide.pty.step${s.key}.detail` as TranslationKey)} /></p>
                  </div>
                </li>
              ))}
            </ol>
          </Advanced>

          <Advanced id="array" title={t("guide.adv.array.title")} hint={t("guide.adv.array.hint")}>
            <p><Rich text={t("guide.adv.array.body")} /></p>
            <Terminal file="sweep.sh" text={ARRAY_SCRIPT} />
            <p>
              <Rich text={t("guide.adv.array.log")} />{sp}
              <Rich
                text={facts.arrayPerUser
                  ? t("guide.adv.array.limit", { p: EXAMPLE_PARTITION.cpu, n: facts.arrayPerUser })
                  : t("guide.adv.array.limitNoData")}
              />
            </p>
          </Advanced>

          {facts.license.length > 0 && (
            <Advanced id="materials-studio" title={t("guide.adv.ms.title")} hint={t("guide.adv.ms.hint")}>
              <p><Rich text={t("guide.adv.ms.body", { parts: facts.license.join(", ") })} /></p>
            </Advanced>
          )}

          <Advanced id="refs" title={t("guide.refs.title")} hint={t("guide.refs.hint")}>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {REFS.map(([label, href]) => (
                <li key={href}>
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 hover:bg-muted/40 hover:text-foreground"
                  >
                    <span className="truncate">{label}</span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                  </a>
                </li>
              ))}
            </ul>
          </Advanced>
        </div>
      </div>
    </div>
  );
}

// ---- building blocks ---------------------------------------------------------------
function StepBadge({ n, small }: { n: number; small?: boolean }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-info-soft font-mono font-semibold text-info-fg ring-1 ring-info/30",
        small ? "h-5 w-5 text-xs" : "h-7 w-7 text-sm",
      )}
      aria-hidden
    >
      {n}
    </span>
  );
}

/** A guide section in the dashboard's shared SectionCard look; `id` is the
 *  deep-link anchor. */
function Section({ id, className, title, lead, extra, children }: {
  id: string;
  className?: string;
  title: string;
  lead?: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div id={id} className={cn("scroll-mt-16", className)}>
      <SectionCard title={title} extra={extra}>
        {lead && <p className="mb-3 text-sm leading-relaxed text-muted-foreground">{lead}</p>}
        {children}
      </SectionCard>
    </div>
  );
}

function KindToggle({ value, onChange, t }: { value: Kind; onChange: (k: Kind) => void; t: TFn }) {
  return (
    <div className="flex h-8 shrink-0 rounded-md border border-border p-0.5" role="group" aria-label={t("guide.kindLabel")}>
      {(["cpu", "gpu"] as const).map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onChange(k)}
          aria-pressed={value === k}
          className={cn(
            "rounded-[4px] px-3 text-xs font-medium transition-colors",
            value === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {k.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

/** Code block — muted in light theme, terminal-dark in dark theme:
 *  `lines` get a $ prompt each; `file` shows a script with its
 *  name in a title bar instead. */
function Terminal({ lines, output, file, text, className }: {
  lines?: string[];
  output?: string;
  file?: string;
  text?: string;
  className?: string;
}) {
  const copyText = file ? (text ?? "") : (lines ?? []).join("\n");
  if (file) {
    return (
      <div className={cn("min-w-0 overflow-hidden rounded-lg border border-border bg-muted/40 dark:border-zinc-800 dark:bg-zinc-950", className)}>
        <div className="flex items-center justify-between border-b border-border px-3 py-1.5 dark:border-zinc-800">
          <span className="font-mono text-xs text-muted-foreground dark:text-zinc-400">{file}</span>
          <CopyButton text={copyText} label className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100" />
        </div>
        <pre className="overflow-x-auto px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground dark:text-zinc-100">
          {(text ?? "").split("\n").map((line, i) => (
            <div key={i} className={cn(line.startsWith("#SBATCH") ? "text-sky-700 dark:text-sky-300" : line.startsWith("#") ? "text-muted-foreground dark:text-zinc-500" : undefined)}>
              {line || " "}
            </div>
          ))}
        </pre>
      </div>
    );
  }
  return (
    <div className={cn("flex min-w-0 items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-950", className)}>
      <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-xs leading-relaxed text-foreground dark:text-zinc-100">
        {(lines ?? []).map((line, i) => (
          <div key={i}>
            <span aria-hidden className="select-none text-muted-foreground dark:text-zinc-500">$ </span>
            {line}
          </div>
        ))}
        {output && <div className="text-muted-foreground dark:text-zinc-500">{output}</div>}
      </pre>
      <CopyButton text={copyText} label className="pt-0.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground dark:text-zinc-400 dark:hover:bg-white/10 dark:hover:text-zinc-100" />
    </div>
  );
}

function Flag({ flag, children }: { flag: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.75rem_minmax(0,1fr)] gap-3 sm:grid-cols-[6.5rem_minmax(0,1fr)]">
      <dt><code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{flag}</code></dt>
      <dd className="leading-relaxed text-muted-foreground">{children}</dd>
    </div>
  );
}

const NOTE_BOX: Record<Tone, string> = {
  ok: "border-ok/35 bg-ok-soft/45",
  warn: "border-warn/40 bg-warn-soft/50",
  bad: "border-bad/35 bg-bad-soft/45",
  info: "border-info/35 bg-info-soft/45",
  neutral: "border-border bg-muted/30",
};
const NOTE_ICON: Record<Tone, string> = {
  ok: "text-ok-fg",
  warn: "text-warn-fg",
  bad: "text-bad-fg",
  info: "text-info-fg",
  neutral: "text-muted-foreground",
};

function Note({ tone, icon: Icon, children }: { tone: Tone; icon: typeof Info; children: ReactNode }) {
  return (
    <div className={cn("flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm leading-relaxed", NOTE_BOX[tone])}>
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", NOTE_ICON[tone])} aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** Text with `backtick` spans rendered as inline code — flags read as flags. */
function Rich({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="whitespace-nowrap rounded bg-muted px-1 py-px font-mono text-[0.85em] text-foreground">{part}</code>
        ) : (
          part
        ),
      )}
    </>
  );
}

function PartitionRow({ row, t }: { row: PartRow; t: TFn }) {
  const purpose = row.gpuLabel
    ? t("guide.part.gpu", { gpu: row.gpuLabel, mem: row.gpuMemGb ?? "—" })
    : t(`guide.part.${row.name}` as TranslationKey);
  const chips = [
    row.wall && t("guide.part.wall", { t: row.wall }),
    row.maxCores && t("guide.part.cores", { n: row.maxCores }),
    row.gpus && t("guide.part.gpus", { n: row.gpus }),
    row.perUser && t("guide.part.perUser", { n: row.perUser }),
  ].filter((c): c is string => !!c);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2.5">
      <div className="flex min-w-0 flex-1 basis-56 items-baseline gap-3">
        <code className="w-16 shrink-0 font-mono text-sm font-semibold">{row.name}</code>
        <span className="text-sm text-muted-foreground">{purpose}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((c) => (
          <span key={c} className="whitespace-nowrap rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{c}</span>
        ))}
      </div>
    </li>
  );
}

/** A collapsed card in the look of the Project page's policy section: one
 *  line (title + hint) until opened. `id` is the deep-link anchor. */
function Advanced({ id, title, hint, children }: { id: string; title: string; hint: string; children: ReactNode }) {
  return (
    <details id={id} className="group scroll-mt-16 rounded-xl border border-border bg-card">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
        <h3 className="text-sm font-medium">{title}</h3>
        <span className="ml-auto text-xs text-muted-foreground">{hint}</span>
      </summary>
      <div className="space-y-3 border-t border-border/60 px-4 pb-4 pt-3 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
    </details>
  );
}
