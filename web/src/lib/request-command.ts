export interface RequestCommandInput {
  partition: string;
  requiredFlags?: string[];
  nodeCount?: number;
  coreCount?: number;
  memValue?: string;
  timeValue?: string;
  forcedInteractiveSeconds: number | null;
  mode: "interactive" | "script";
  pty: boolean;
  ptyTime: string;
  scriptFile: string;
}

export type BackfillVariant = "script" | "switch" | "fits" | null;

/** The gap-shell box exists only while the recipe is active: it then holds
 * the usage note and the only restore control, and must survive tips
 * recomputing to null on a later poll. There is no standalone pre-activation
 * pitch — when the gap is shorter than the pinned 12 h, the backfill tip's
 * "switch" button is the entry; when the gap already holds 12 h, a plain
 * salloc fits it and the pitch's premise ("12 h rarely fits a gap") would
 * contradict the tip one line above. */
export function shouldShowGapShell(input: {
  isGpu: boolean;
  mode: "interactive" | "script";
  ptyActive: boolean;
}) {
  return input.isGpu && input.mode === "interactive" && input.ptyActive;
}

/** Pure, testable Slurm command builder used by the quick-request UI. */
export function buildRequestCommand(input: RequestCommandInput) {
  const flags = [`-p ${input.partition}`, ...(input.requiredFlags ?? [])];
  if (input.nodeCount) flags.push(`-N ${input.nodeCount}`);
  if (input.coreCount) flags.push(`-c ${input.coreCount}`);
  if (input.memValue) flags.push(`--mem=${input.memValue}`);
  // A -t on a plugin-forced plain salloc is silently ignored. The pty recipe
  // rides on sbatch, so its walltime remains explicit and effective.
  if (!input.pty && input.timeValue && input.forcedInteractiveSeconds === null) {
    flags.push(`-t ${input.timeValue}`);
  }

  if (input.pty) {
    return [
      `JOB=$(sbatch --parsable ${[...flags, `-t ${input.ptyTime}`].join(" ")} --wrap 'sleep infinity')`,
      'echo "job $JOB submitted"',
      'while :; do S=$(squeue -h -j "$JOB" -o \'%T %r\'); case "$S" in RUNNING*|"") break;; esac; printf \'\\r%s waiting — %s   \' "$(date +%T)" "$S"; sleep 5; done',
      'printf \'\\rjob %s started — opening shell (exit releases it)\\n\' "$JOB"',
      'srun --jobid "$JOB" --overlap --pty bash',
      'scancel "$JOB" 2>/dev/null; echo "job $JOB released"',
    ].join("\n");
  }
  if (input.mode === "interactive") return `salloc ${flags.join(" ")}`;
  return `sbatch ${flags.join(" ")} ${input.scriptFile.trim() || "job.sh"}`;
}
