# Architecture review — 2026-09-05

Scope: source inspection, backend unit tests, frontend domain tests, lint and
production build. No live cluster queries or service restart.

## Keep

The Source → normalize → Engine → Store/HTTP split is appropriate for this
dashboard. A single collector shared by all viewers protects the login nodes;
SQLite and a standard-library backend keep deployment small. Route splitting
and a single live connection per app are also worth retaining.

## Fixed in this review

- **Failed collection could look successful.** The shell script previously
  continued after failed core `scontrol`/`squeue` reads and returned the exit
  status of an optional command. Both core reads now abort on failure, allowing
  SSH fallback and the engine's stale-data path to work. Empty successful queues
  remain valid; optional probes remain best effort.
- **History deduplication was process-local.** `_last_ts` missed duplicates
  after restart or out-of-order retries, and was set before a successful commit.
  The raw timestamp primary key now controls insertion and hourly aggregation
  in one transaction. Duplicate timestamps keep the first committed sample;
  failed transactions can be retried.
- **Polling could overwrite a recovered SSE stream.** In-flight fallback
  responses and errors are now invalidated when SSE recovers. Slow polls cannot
  overlap, and unsubscribed consumers do not receive results.
- **Unused dependencies/configuration.** Removed unused Radix scroll-area,
  select, separator and tabs packages, and the 900 KB warning override justified
  by the already-removed Tremor/Recharts stack. Default chunk warnings apply.
- **Dependency audit.** Updated transitive Browserslist/Nanoid packages within
  existing dependency ranges; npm's reported vulnerabilities went from 2 to 0.

Regression tests execute the generated collection script against shell stubs,
exercise SQLite rollback/reopen, and control the SSE/polling completion order.
Validation: 34 backend tests and 49 frontend tests pass, as do frontend lint
and the production build.

## Next architectural improvements

1. **Separate storage health from collection health** (`Engine._collect`).
   `store.record` and `prune` share the outer collection exception handler.
   A database failure labels successfully collected data stale and skips login
   collection. Give persistence its own error state and expose it in health and
   the UI while still broadcasting fresh data. This needs an explicit health
   contract so a history outage does not become invisible.
2. **Give login sampling its own schedule** (`Engine.run`, `LoginNodeCollector.fetch`).
   Login collection only runs after a successful cluster cycle. Its configured
   interval is a cache TTL, so setting it below the cluster interval cannot
   increase sampling frequency; cluster failure also stops login refreshes.
   A dedicated bounded sampler would isolate these failure paths. Preserve the
   single-collector rule and cached HTTP reads when making that change.
3. **Bound HTTP request lifetime.** SSE subscriptions are capped, but the
   `ThreadingHTTPServer` connection threads and socket writes have no explicit
   application timeout. Test slow-reader behavior and the deployment proxy's
   limits before increasing public traffic or the SSE cap.

These changes are more useful than introducing microservices, a message broker,
or another backend framework. The scheduling/domain helpers already have
dedicated tests and should not be removed merely because they are substantial.
