import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DICTS, loadLang } from "@/i18n/core";
import { fmtMB } from "@/lib/format";
import { isLicensePartition } from "@/lib/slurm";
import { applySite, partitionOrderRank, registerPoolLabels, type SiteInfo } from "@/lib/site";
import type { PolicySnapshot, Pool } from "@/types/snapshot";

const site = (over: Partial<SiteInfo> = {}): SiteInfo => ({
  cluster: "mycluster", name: "Mycluster", org: "", links: {},
  pages: { slurm_guide: false }, partition_order: [], strings: {}, ...over,
});
const dict = (lang: "en" | "zh" | "ja") => DICTS[lang] as Record<string, string>;

beforeAll(() => Promise.all([loadLang("zh"), loadLang("ja")]));
afterEach(() => applySite(site()));

describe("site", () => {
  it("fills the site name into the built-in text", () => {
    applySite(site());
    expect(dict("en")["app.title"]).toBe("Mycluster Monitor");
    expect(dict("zh")["pool.outsideCard"]).toContain("mycluster");
  });

  it("lets the site's strings win, per language", () => {
    applySite(site({ strings: { zh: { "app.subtitle": "某大学集群" } } }));
    expect(dict("zh")["app.subtitle"]).toBe("某大学集群");
    expect(dict("en")["app.subtitle"]).toBe("Slurm cluster");
  });

  it("orders partitions by the site's list, unknown ones last", () => {
    applySite(site({ partition_order: ["gpu", "cpu"] }));
    expect(partitionOrderRank("cpu")).toBe(1);
    expect(partitionOrderRank("gpu,cpu")).toBe(0);
    expect(partitionOrderRank("other")).toBe(2);
  });

  it("names pools the site file does not", () => {
    applySite(site());
    registerPoolLabels([
      { id: "cpu-64c-256g", gpu: null } as unknown as Pool,
      { id: "cpu-128c-512g", gpu: null } as unknown as Pool,
      { id: "cpu-128c-2048g", gpu: null, mem_per_node: 2060000 } as unknown as Pool,
      { id: "l40s", gpu: { label: "L40S" } } as unknown as Pool,
    ]);
    expect(dict("en")["pool.cpu-64c-256g"]).toBe("CPU · 64 cores");
    expect(dict("en")["pool.cpu-128c-2048g"]).toBe(`CPU · 128 cores · ${fmtMB(2060000)}`);
    expect(dict("zh")["pool.cpu-64c-256g"]).toBe("CPU · 64 核");
    expect(dict("ja")["pool.l40s"]).toBe("L40S");
  });

  it("gives a dictionary that loads later the site's text and pool names", async () => {
    applySite(site());
    registerPoolLabels([{ id: "l40s", gpu: { label: "L40S" } } as unknown as Pool]);
    await loadLang("ko");
    const ko = DICTS.ko as Record<string, string>;
    expect(ko["app.title"]).toContain("Mycluster");
    expect(ko["pool.l40s"]).toBe("L40S");
  });

  it("keeps a late-loaded language's site label over the generated one", async () => {
    applySite(site({ strings: { fr: { "pool.h100": "H100 (cloud)" } } }));
    registerPoolLabels([{ id: "h100", gpu: { label: "H100" } } as unknown as Pool]);
    expect(dict("en")["pool.h100"]).toBe("H100");
    await loadLang("fr");
    expect((DICTS.fr as Record<string, string>)["pool.h100"]).toBe("H100 (cloud)");
  });

  it("calls the only CPU shape just CPU", () => {
    applySite(site());
    registerPoolLabels([{ id: "cpu-64c-256g", gpu: null } as unknown as Pool]);
    expect(dict("en")["pool.cpu-64c-256g"]).toBe("CPU");
  });

  it("treats partitions that need a license as license-only", () => {
    const policy = { partition_defaults: { ms: { requires_license: true }, x: { default_license: "a@b:1" }, cpu: {} } } as unknown as PolicySnapshot;
    expect(isLicensePartition("ms", policy)).toBe(true);
    expect(isLicensePartition("x", policy)).toBe(true);
    expect(isLicensePartition("cpu", policy)).toBe(false);
  });
});
