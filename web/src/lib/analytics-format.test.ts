import { describe, expect, it } from "vitest";
import { DICTS, type TFn, type TranslationKey } from "@/i18n/core";
import {
  bestWindow,
  concentrationFinding,
  hourRange,
  limitStartFinding,
  pctText,
  recentWeeks,
  shapeLabels,
  submitFinding,
  unitSteps,
  usersFinding,
  waitText,
} from "./analytics-format";
import type { AnalyticsView } from "@/types/analytics";

const tFor = (lang: "en" | "zh" | "ja"): TFn => (key: TranslationKey, vars) => {
  let s = DICTS[lang][key] ?? key;
  for (const k in vars ?? {}) s = s.replaceAll(`{${k}}`, String(vars![k]));
  return s;
};
const zh = tFor("zh");
const en = tFor("en");

describe("formatting", () => {
  it("shares", () => {
    expect(pctText(0.509)).toBe("51%");
    expect(pctText(0.002)).toBe("<1%");
    expect(pctText(0)).toBe("0%");
    expect(pctText(null)).toBe("—");
  });

  it("waits in one unit", () => {
    expect(waitText(zh, 30)).toBe("30 秒");
    expect(waitText(zh, 129)).toBe("2 分钟");
    expect(waitText(zh, 20227)).toBe("5.6 小时");
    expect(waitText(zh, 83135)).toBe("23 小时");
    expect(waitText(en, 496650)).toBe("5.7 d");
  });

  it("hour ranges wrap past midnight", () => {
    expect(hourRange(zh, 13, 4)).toBe("13–17 时");
    expect(hourRange(en, 5, 4)).toBe("05:00–09:00");
    expect(hourRange(zh, 22, 4)).toBe("22–02 时");
    expect(hourRange(zh, 20, 4)).toBe("20–24 时");
  });

  it("ordinal steps spread over the five-step ramp", () => {
    expect(unitSteps(3)).toEqual([1, 3, 5]);
    expect(unitSteps(5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("shape labels match the backend bucket bounds", () => {
    expect(shapeLabels(zh, "gpu")).toHaveLength(3);          // UNIT_BOUNDS gpu (1, 2)
    expect(shapeLabels(zh, "cpu")).toHaveLength(5);          // UNIT_BOUNDS cpu (1, 16, 64, 256)
  });
});

describe("findings", () => {
  it("best window skips hours without data and wraps", () => {
    const series = Array.from({ length: 24 }, (_, h) => (h >= 22 || h < 2 ? 1 : 0.2)) as (number | null)[];
    expect(bestWindow(series, 4, "max")).toEqual({ from: 22, avg: 1 });
    series[23] = null;
    expect(bestWindow(series, 4, "max")?.from).not.toBe(22);
  });

  it("submit finding uses weekdays only", () => {
    const row = (peak: number) => Array.from({ length: 24 }, (_, h) => (h >= 14 && h < 18 ? peak : 1));
    const view = { submit: { cells: [...Array(5)].map(() => row(3)).concat([row(9), row(9)]) } } as AnalyticsView;
    const f = submitFinding(view)!;
    expect(f.peak).toEqual({ from: 14, avg: 3 });
    expect(f.low.avg).toBe(1);
  });

  it("limit-vs-start compares the first and last drawn buckets", () => {
    const view = {
      limit_start: {
        bounds: [60, 360, 1440, 4320],
        pools: [
          { id: "a40", share: [0.8, 0.75, null, 0.66, 0.55], users: [41, 34, 2, 23, 49] },
          { id: "h100", share: [0.64, null, null, 0.57, null], users: [11, 3, 4, 20, 0] },
        ],
      },
    } as AnalyticsView;
    expect(limitStartFinding(view)).toMatchObject({ first: 0, last: 4, a: 0.8, b: 0.55 });
  });

  it("concentration stops at the top-20 group", () => {
    const view = {
      concentration: {
        users: 113, unit_hours: 1, half: 8,
        groups: [
          { from: 1, to: 1, share: 0.151 }, { from: 2, to: 5, share: 0.251 },
          { from: 6, to: 10, share: 0.188 }, { from: 11, to: 20, share: 0.215 },
          { from: 21, to: 113, share: 0.195, rest: true },
        ],
      },
    } as AnalyticsView;
    const f = concentrationFinding(view)!;
    expect(f.n).toBe(20);
    expect(f.share).toBeCloseTo(0.805);
    expect(f.people).toBeCloseTo(20 / 113);
  });

  it("weekly users leave out the running week", () => {
    expect(recentWeeks([1, 2, 3, 4], true, 2)).toEqual([2, 3]);
    const view = {
      weekly: { users: [24, 48, 64, 40, 20], partial: true, new_users: [{ month: "2026-04", users: 84 }, { month: "2026-05", users: 22 }] },
    } as unknown as AnalyticsView;
    expect(usersFinding(view)).toMatchObject({ min: 24, max: 64, top: { month: "2026-04" } });
  });
});

describe("dictionaries", () => {
  it("every language has every analytics key with the same placeholders", () => {
    const keys = Object.keys(DICTS.en).filter((k) => k.startsWith("an.")) as TranslationKey[];
    expect(keys.length).toBeGreaterThan(150);
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    for (const lang of ["zh", "ja"] as const) {
      for (const k of keys) {
        expect(DICTS[lang][k], `${lang} ${k}`).toBeTruthy();
        expect(holes(DICTS[lang][k]), `${lang} ${k}`).toBe(holes(DICTS.en[k]));
      }
    }
  });
});

describe("unit spacing", () => {
  it("drops the space around a CJK unit only", async () => {
    const { tidyUnits } = await import("./analytics-format");
    expect(tidyUnits("用掉了 {s} 的 {unitH}；", { unitH: "核·时" })).toBe("用掉了 {s} 的{unitH}；");
    expect(tidyUnits("占交互 {unitH} 的 {b}", { unitH: "GPU·时" })).toBe("占交互 {unitH}的 {b}");
    expect(tidyUnits("Of {unitH}", { unitH: "core·h" })).toBe("Of {unitH}");
  });
});
