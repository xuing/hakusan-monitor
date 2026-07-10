import { describe, expect, it } from "vitest";
import { buildRequestCommand, shouldShowGapShell } from "./request-command";

describe("buildRequestCommand", () => {
  it("omits an ignored walltime from plugin-forced plain interactive requests", () => {
    expect(buildRequestCommand({
      partition: "GPU-1",
      nodeCount: 1,
      coreCount: 26,
      memValue: "200G",
      timeValue: "1:00:00",
      forcedInteractiveSeconds: 12 * 3600,
      mode: "interactive",
      pty: false,
      ptyTime: "1:00:00",
      scriptFile: "job.sh",
    })).toBe("salloc -p GPU-1 -N 1 -c 26 --mem=200G");
  });

  it("keeps walltime for batch and builds the requested script path", () => {
    expect(buildRequestCommand({
      partition: "DEF",
      timeValue: "2:00:00",
      forcedInteractiveSeconds: null,
      mode: "script",
      pty: false,
      ptyTime: "2:00:00",
      scriptFile: "train.sh",
    })).toBe("sbatch -p DEF -t 2:00:00 train.sh");
  });

  it("builds a self-cleaning pty recipe", () => {
    const command = buildRequestCommand({
      partition: "GPU-S",
      requiredFlags: ["--gres=gpu:1"],
      memValue: "240G",
      forcedInteractiveSeconds: 12 * 3600,
      mode: "interactive",
      pty: true,
      ptyTime: "1:30:00",
      scriptFile: "job.sh",
    });
    expect(command).toContain("sbatch --parsable -p GPU-S --gres=gpu:1 --mem=240G -t 1:30:00");
    expect(command).toContain("srun --jobid \"$JOB\" --overlap --pty bash");
    expect(command).toContain("scancel \"$JOB\"");
  });
});

describe("shouldShowGapShell", () => {
  it("hides the affordance when a queued pool has no real backfill window", () => {
    expect(shouldShowGapShell({
      isGpu: true,
      mode: "interactive",
      ptyActive: false,
      backfillAvailable: false,
      backfillVariant: null,
      queueWarn: true,
    })).toBe(false);
  });

  it("shows only a usable GPU backfill path", () => {
    expect(shouldShowGapShell({
      isGpu: true,
      mode: "interactive",
      ptyActive: false,
      backfillAvailable: true,
      backfillVariant: "fits",
      queueWarn: true,
    })).toBe(true);
    expect(shouldShowGapShell({
      isGpu: true,
      mode: "interactive",
      ptyActive: false,
      backfillAvailable: true,
      backfillVariant: "switch",
      queueWarn: true,
    })).toBe(false);
  });

  it("keeps the active-session box (and its restore control) when tips vanish", () => {
    // a later SSE poll can null the backfill tip while the user is still
    // inside the pty recipe — the only way back must not disappear
    expect(shouldShowGapShell({
      isGpu: true,
      mode: "interactive",
      ptyActive: true,
      backfillAvailable: false,
      backfillVariant: null,
      queueWarn: false,
    })).toBe(true);
  });
});
