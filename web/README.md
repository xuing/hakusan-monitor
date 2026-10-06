# Hakusan Monitor — web

The frontend: a **React + TypeScript** SPA built with **Vite, Tailwind CSS,
shadcn/ui, lightweight local SVG charts and Radix Colors**. It consumes the Python backend's JSON API
and is served (as a static build in `web/dist`) by that same backend.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173 — proxies /api → :8787 (run the backend too)
```

## Build / lint / test

```bash
npm run build    # → web/dist (the backend serves this)
npm run lint     # oxlint
npm test         # Vitest unit tests
```

## Structure

```
src/
  pages/         one file per route (overview, partitions, analytics, nodes,
                 jobs, login-nodes, slurm-guide, containers, project-guide)
  components/
    pools/       Overview pool groups and cards: occupants, pending jobs
    request/     quick-request panel, its partition table and parts
    partitions/  the Partitions page list
    dashboard/   other live widgets: KPIs, releases, queue, down nodes, users
    analytics/   Analytics cards
    data/        TanStack tables (nodes, jobs) and column definitions
    guide/       policy-source viewer on the project page
    layout/      app shell: sidebar, topbar, footer, language, resource filter
    common/      shared pieces: section card, bars, tags, verdict wording
    charts/      owned SVG charts
    ui/          shadcn/ui primitives (owned, copy-in)
  hooks/         live snapshot (SSE), API fetch, resource filter, theme
  i18n/          en / ja / zh dictionaries; ja and zh are typed against en
  lib/           domain logic as plain functions, tested with vitest:
                 queue.ts (the pending-queue model), gpu-partition.ts and
                 cpu-partition.ts (one start verdict per partition),
                 pool-status.ts (a pool's tone), gpu-availability.ts and
                 gpu-fit.ts (per-node GPU states), slurm.ts (policy),
                 cluster-time.ts (Slurm times in the cluster's zone),
                 request-*.ts (the quick request's input, limits, command)
  types/         snapshot and API types
```

How these fit together, and why: [`../docs/DESIGN.md`](../docs/DESIGN.md).

The theme is built on **Radix Colors** scales (`src/index.css`); semantic
status tokens map to their high-contrast steps in `tailwind.config.js`.
