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
  pages/         route entry points: overview, partitions, analytics, nodes, jobs
  components/
    layout/      app shell — sidebar, topbar, footer, language + resource filter
    dashboard/   live monitor widgets — KPIs, GPU board, releases, queue, …
    data/        TanStack data tables (nodes, jobs) + column defs
    analytics/   usage heatmap + trend charts
    common/      shared building blocks — section card, bar, tag, empty
    ui/          shadcn/ui primitives (owned, copy-in)
  hooks/         use-live (SSE), use-api, use-resource-filter
  i18n/          ja / en / zh dictionaries (type-checked for completeness)
  lib/           api client, live transport, formatters, slurm + theme helpers
  types/         snapshot + raw API types
```

The dark theme is built on **Radix Colors** scales (`src/index.css`); semantic
status tokens map to the accessible high-contrast steps in `tailwind.config.js`.
