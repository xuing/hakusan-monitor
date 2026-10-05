import { describe, expect, it } from "vitest";
import { DICTS, LANGS, reasonDescription, reasonLabel, type TFn, type TranslationKey } from "./core";

const tFor = (lang: (typeof LANGS)[number]): TFn => (key) => DICTS[lang][key] ?? key;

// pending reasons squeue reported on hakusan, 2026-10-05
const LIVE = [
  "QOSMaxJobsPerUserLimit", "Priority", "QOSGrpJobsLimit", "Dependency", "DependencyNeverSatisfied",
  "Resources", "JobHeldAdmin", "InvalidAccount", "None",
  "Nodes required for job are DOWN, DRAINED or reserved for jobs in higher priority partitions",
];

describe("pending reasons", () => {
  it("every reason seen live has a label and Slurm's meaning in all three languages", () => {
    for (const lang of LANGS) {
      const t = tFor(lang);
      for (const raw of LIVE) {
        expect(reasonLabel(t, raw), `${lang} ${raw}`).not.toBe(raw);
        expect(reasonDescription(t, raw), `${lang} ${raw}`).not.toBe("");
      }
    }
  });

  it("every labelled code carries a description", () => {
    const codes = Object.keys(DICTS.en).filter((k) => k.startsWith("reason.") && !k.endsWith(".desc"));
    for (const lang of LANGS) {
      for (const k of codes) expect(DICTS[lang][`${k}.desc` as TranslationKey], `${lang} ${k}`).toBeTruthy();
    }
  });

  it("a Slurm sentence falls back to its first word; an unknown code stays as it is", () => {
    const t = tFor("zh");
    expect(reasonLabel(t, LIVE[LIVE.length - 1])).toBe("节点不可用");
    expect(reasonLabel(t, "SomeNewReason")).toBe("SomeNewReason");
    expect(reasonDescription(t, "SomeNewReason")).toBe("");
  });
});
