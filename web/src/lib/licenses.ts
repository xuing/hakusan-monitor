import type { ClusterLicense, PartitionDefaults } from "@/types/snapshot";

/**
 * How a partition's job gets its -L, from the submit plugin's branch and the
 * cluster's own license list (measured 2026-10-05 with held jobs):
 *  - MatStudio rejects a job without -L ("requires license specification");
 *  - MS_Castep & co. fill in a default (`ms_castep@lmgr:1`) when none is given;
 *  - MS_Amorphous fills in `ms_amorphous@lmgr`, a name the cluster does not
 *    have — the job is refused ("Invalid license specification") unless -L
 *    names the real one, `ms_amorphouscell@lmgr`.
 */
export interface LicensePlan {
  kind: "none" | "required" | "default" | "fixed" | "missing";
  /** the -L the command must carry ("" = none) */
  flag: string;
  /** the license the job consumes, when known */
  name: string | null;
  count: number;
  /** what the plugin fills in, for kind default / fixed / missing */
  pluginDefault?: string;
  /** that license's live counts */
  license?: ClusterLicense;
}

const splitSpec = (spec: string) => {
  const [name, n] = spec.split(":");
  return { name, count: Math.max(1, Number(n) || 1) };
};

const base = (name: string) => name.split("@")[0];

export function licensePlan(defaults: PartitionDefaults, licenses: ClusterLicense[], chosen: string, placeholder: string): LicensePlan {
  const find = (name: string) => licenses.find((l) => l.name === name);
  if (defaults.requires_license) {
    if (!chosen) return { kind: "required", flag: `-L ${placeholder}`, name: null, count: 1 };
    return { kind: "required", flag: `-L ${chosen}:1`, name: chosen, count: 1, license: find(chosen) };
  }
  if (!defaults.default_license) return { kind: "none", flag: "", name: null, count: 0 };
  const { name, count } = splitSpec(defaults.default_license);
  const own = find(name);
  // no license list yet: trust the plugin's default rather than guess
  if (own || licenses.length === 0) {
    return { kind: "default", flag: "", name, count, pluginDefault: defaults.default_license, license: own };
  }
  // the plugin's name is not on the cluster: the one sharing its stem is
  // what the job has to ask for ("ms_amorphous" -> "ms_amorphouscell")
  const fix = licenses.find((l) => base(l.name).startsWith(base(name)));
  if (fix) {
    return { kind: "fixed", flag: `-L ${fix.name}:${count}`, name: fix.name, count, pluginDefault: name, license: fix };
  }
  return { kind: "missing", flag: "", name, count, pluginDefault: name };
}

/** All of that license is taken: Slurm holds the job (Reason=Licenses). */
export const licenseBusy = (plan: LicensePlan) => Boolean(plan.license && plan.license.free < plan.count);
