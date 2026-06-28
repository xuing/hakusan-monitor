#!/usr/bin/env python3
"""Seed the time-series store with ~14 days of synthetic history so the
analytics (peak/trough) view is demonstrable without waiting for real sampling.

Usage:  python3 scripts/seed_demo.py [data/hakusan.sqlite] [days]
The pattern is diurnal (busy 9-19 local) + weekly (weekdays busier) — purely for
demo; real deployments fill this from the live sampler.
"""
import os, sys, time, math
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
from store import Store  # noqa: E402

db = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(__file__), "..", "data", "hakusan.sqlite")
days = int(sys.argv[2]) if len(sys.argv) > 2 else 14

store = Store(db)


def snap(cpu, gpu, mem, run, pend):
    return {
        "totals": {
            "cpus": {"util": round(cpu, 3), "total": 35064, "alloc": int(cpu * 35064)},
            "gpus": {"util": round(gpu, 3), "total": 80, "used": int(gpu * 80)},
            "memory": {"util": round(mem, 3)},
            "nodes": {"total": 219, "available": int(219 * (1 - cpu) + 8), "down": 17},
        },
        "queue": {"running": run, "pending": pend},
        "pools": [], "gpus": [],
    }


now = int(time.time())
start = now - days * 86400
n = 0
for ts in range(start, now, 3600):
    lt = time.localtime(ts)
    hod, wd = lt.tm_hour, lt.tm_wday          # wd: 0=Mon..6=Sun
    day = 0.5 - 0.5 * math.cos((hod - 3) / 24 * 2 * math.pi)   # peak ~15:00
    week = 1.0 if wd < 5 else 0.55                              # weekends quieter
    wobble = 0.05 * math.sin(ts / 9000.0)
    load = max(0.05, min(0.99, 0.45 + 0.45 * day * week + wobble))
    gpu = max(0.05, min(1.0, 0.55 + 0.42 * day * week + wobble))
    pend = int(max(0, 160 * day * week + 10 * math.sin(ts / 7000.0)))
    run = int(120 + 180 * day * week)
    store.record(snap(load, gpu, load * 0.9, run, pend), ts)
    n += 1

print(f"seeded {n} hourly points over {days} days into {os.path.abspath(db)}")
print("store stats:", store.stats())
