import { describe, expect, it } from "vitest";
import { licenseBusy, licensePlan } from "./licenses";

// cluster licenses as `scontrol show lic` listed them on 2026-10-05
const LICENSES = [
  { name: "ms_amorphouscell@lmgr", total: 1, used: 0, free: 1 },
  { name: "ms_castep@lmgr", total: 32, used: 3, free: 29 },
  { name: "ms_dmol@lmgr", total: 96, used: 96, free: 0 },
];

describe("licensePlan (held jobs, 2026-10-05)", () => {
  it("MatStudio: -L is required; a placeholder until one is picked", () => {
    expect(licensePlan({ requires_license: true }, LICENSES, "", "<license>").flag).toBe("-L <license>");
    const picked = licensePlan({ requires_license: true }, LICENSES, "ms_castep@lmgr", "<license>");
    expect(picked.flag).toBe("-L ms_castep@lmgr:1");
    expect(picked.license?.free).toBe(29);
  });

  it("MS_Castep: the plugin's default needs no flag", () => {
    const plan = licensePlan({ default_license: "ms_castep@lmgr:1" }, LICENSES, "", "<license>");
    expect(plan.kind).toBe("default");
    expect(plan.flag).toBe("");
  });

  it("MS_Amorphous: the plugin's default does not exist, the real name goes in -L", () => {
    const plan = licensePlan({ default_license: "ms_amorphous@lmgr:1" }, LICENSES, "", "<license>");
    expect(plan.kind).toBe("fixed");
    expect(plan.flag).toBe("-L ms_amorphouscell@lmgr:1");
  });

  it("a fully used license queues the job", () => {
    expect(licenseBusy(licensePlan({ default_license: "ms_dmol@lmgr:1" }, LICENSES, "", "<license>"))).toBe(true);
    expect(licenseBusy(licensePlan({ default_license: "ms_castep@lmgr:1" }, LICENSES, "", "<license>"))).toBe(false);
  });

  it("no license rule: nothing to add", () => {
    expect(licensePlan({}, LICENSES, "", "<license>")).toMatchObject({ kind: "none", flag: "" });
  });
});
