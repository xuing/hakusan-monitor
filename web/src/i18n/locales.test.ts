import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { browserLang, DICTS, LANGS, loadLang, matchLang } from "./core";

// ja and zh are written by hand and may name a value English leaves out
// ("同じノードの {n} 枚"); the translated locales keep English's exactly
const HAND = new Set(["en", "ja", "zh"]);
const holes = (s: string) => [...s.matchAll(/\{[a-zA-Z]+\}/g)].map((m) => m[0]).sort().join(",");
const code = (s: string) => [...s.matchAll(/`[^`]+`/g)].map((m) => m[0]).sort().join("\n");

beforeAll(() => Promise.all(LANGS.map(loadLang)));

describe("dictionaries", () => {
  it("every language has every key, the same {placeholders} and the same `code`", () => {
    const en = DICTS.en as Record<string, string>;
    for (const lang of LANGS) {
      const dict = DICTS[lang] as Record<string, string>;
      expect(Object.keys(dict).sort(), lang).toEqual(Object.keys(en).sort());
      for (const key in en) {
        expect(typeof dict[key], `${lang} ${key}`).toBe("string");
        if (HAND.has(lang)) continue;
        if (en[key].trim()) expect(dict[key].trim(), `${lang} ${key}`).toBeTruthy();
        expect(holes(dict[key]), `${lang} ${key}`).toBe(holes(en[key]));
        expect(code(dict[key]), `${lang} ${key}`).toBe(code(en[key]));
      }
    }
  });

  it("the Hakusan site file has its text in every language", () => {
    const file = path.resolve(import.meta.dirname, "../../../sites/hakusan.json");
    const strings = JSON.parse(fs.readFileSync(file, "utf8")).strings as Record<string, Record<string, string>>;
    const en = strings.en;
    for (const lang of LANGS) {
      expect(Object.keys(strings[lang] ?? {}).sort(), lang).toEqual(Object.keys(en).sort());
      if (HAND.has(lang)) continue;
      for (const key in en) {
        expect(holes(strings[lang][key]), `${lang} ${key}`).toBe(holes(en[key]));
        expect(code(strings[lang][key]), `${lang} ${key}`).toBe(code(en[key]));
      }
    }
  });
});

describe("browser language", () => {
  it("maps browser tags to a UI language", () => {
    expect(matchLang("zh-CN")).toBe("zh");
    expect(matchLang("zh-TW")).toBe("zh-Hant");
    expect(matchLang("zh-Hant-HK")).toBe("zh-Hant");
    expect(matchLang("pt-BR")).toBe("pt");
    expect(matchLang("tl")).toBe("fil");
    expect(matchLang("ur-PK")).toBe("ur");
    expect(matchLang("sw")).toBeNull();
  });

  it("takes the first browser language the UI has, else English", () => {
    expect(browserLang(["sw", "bn-BD", "en"])).toBe("bn");
    expect(browserLang(["sw"])).toBe("en");
  });
});
