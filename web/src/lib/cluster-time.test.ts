import { describe, expect, it } from "vitest";
import { clusterClock, clusterDayOffset, clusterMs } from "./cluster-time";

describe("Slurm times are read in the cluster's zone", () => {
  it("reads a time without offset in the given zone, whatever the viewer's", () => {
    expect(clusterMs("2026-10-06T23:10:00", "Asia/Tokyo")).toBe(Date.parse("2026-10-06T23:10:00+09:00"));
    expect(clusterMs("2026-10-06T23:10:00", "UTC")).toBe(Date.parse("2026-10-06T23:10:00Z"));
  });

  it("follows daylight saving time", () => {
    // New York: EST (-05:00) until 2026-03-08 02:00, EDT (-04:00) after
    expect(clusterMs("2026-03-07T12:00:00", "America/New_York")).toBe(Date.parse("2026-03-07T12:00:00-05:00"));
    expect(clusterMs("2026-03-09T12:00:00", "America/New_York")).toBe(Date.parse("2026-03-09T12:00:00-04:00"));
  });

  it("is NaN for anything that is not a time", () => {
    expect(clusterMs("", "Asia/Tokyo")).toBeNaN();
    expect(clusterMs("N/A", "Asia/Tokyo")).toBeNaN();
    expect(clusterMs(undefined, "Asia/Tokyo")).toBeNaN();
  });

  it("shows an instant on the cluster's clock", () => {
    const now = Date.parse("2026-10-06T22:00:00+09:00");
    expect(clusterClock(Date.parse("2026-10-06T23:44:00+09:00"), "Asia/Tokyo", now)).toBe("23:44");
    expect(clusterClock(Date.parse("2026-10-07T01:05:00+09:00"), "Asia/Tokyo", now)).toBe("10/7 01:05");
    expect(clusterClock(Date.parse("2026-10-06T23:44:00+09:00"), "UTC", now)).toBe("14:44");
  });

  it("names the cluster's today and tomorrow", () => {
    const now = Date.parse("2026-10-06T23:30:00+09:00");
    expect(clusterDayOffset("2026-10-06T23:50:00", "Asia/Tokyo", now)).toBe(0);
    expect(clusterDayOffset("2026-10-07T02:39:00", "Asia/Tokyo", now)).toBe(1);
    expect(clusterDayOffset("2026-10-05T10:00:00", "Asia/Tokyo", now)).toBe(2);
    // 14:30 on 10-06 in UTC: the 10-07 release is still tomorrow there
    expect(clusterDayOffset("2026-10-07T02:39:00", "UTC", now)).toBe(1);
  });

  it("names tomorrow by the calendar on a 25 h or 23 h day", () => {
    expect(clusterDayOffset("2026-11-02T08:00:00", "America/New_York", Date.parse("2026-11-01T00:30:00-04:00"))).toBe(1);
    expect(clusterDayOffset("2026-03-09T08:00:00", "America/New_York", Date.parse("2026-03-07T23:30:00-05:00"))).toBe(2);
  });
});
