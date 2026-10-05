import { describe, expect, it } from "vitest";
import { nextUpOrder } from "./pending-order";
import type { RawJob } from "@/types/snapshot";

const job = (job_id: number, state_reason: string, priority: number, start_est = "") =>
  ({ job_id, state_reason, priority, start_est, job_state: "PENDING", partition: "GPU-1" }) as unknown as RawJob;

describe("nextUpOrder (GPU-1 queue, squeue on 2026-10-05)", () => {
  it("planned starts first, then priority; limit-held after; never-start last", () => {
    // squeue's own order: partition, then priority — the limit-held jobs lead
    const squeue = [
      job(756866, "QOSMaxJobsPerUserLimit", 25222),
      job(756864, "QOSMaxJobsPerUserLimit", 25222),
      job(778827, "Resources", 22691, "2026-10-06T12:15:42"),
      job(507503, "Dependency", 21926),
      job(507501, "DependencyNeverSatisfied", 21926),
      job(778799, "Priority", 20984, "2026-10-07T02:20:41"),
      job(778900, "Priority", 21500),
      job(668942, "JobHeldAdmin", 30000),
    ];
    expect(nextUpOrder(squeue).map((j) => j.job_id)).toEqual([
      778827, 778799, 778900,   // the scheduler's next: by planned start, then priority
      756866, 756864, 507503,   // held by a QOS limit or a dependency
      668942, 507501,           // never start on their own (priority decides between them)
    ]);
  });
});
