import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NAV } from "./nav";

// index.html derives the mount prefix from the page URL; run that snippet.
const html = readFileSync(path.resolve(import.meta.dirname, "../../index.html"), "utf8");
const snippet = html.match(/<script>\s*(\/\/ Mount prefix[\s\S]*?)<\/script>/)![1];

function baseFor(pathname: string): string {
  const head = { appended: "" as string, appendChild(el: { href: string }) { this.appended = el.href; } };
  const doc = { head, createElement: () => ({ href: "" }) };
  new Function("location", "document", snippet)({ pathname }, doc);
  return head.appended;
}

describe("index.html mount prefix", () => {
  it("reads the proxy prefix from any page URL", () => {
    expect(baseFor("/hakusan/")).toBe("/hakusan/");
    expect(baseFor("/hakusan")).toBe("/hakusan/");
    expect(baseFor("/hakusan/slurm")).toBe("/hakusan/");
  });

  it("is the root at the site root", () => {
    expect(baseFor("/")).toBe("/");
    expect(baseFor("/jobs")).toBe("/");
  });

  it("knows every routed page", () => {
    for (const item of NAV.filter((n) => n.path !== "/")) {
      expect(baseFor(`/hakusan${item.path}`)).toBe("/hakusan/");
    }
  });
});
