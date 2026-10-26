# Tasks

## 1. Aggregate overview API

- [x] 1.1 Separate job rows from Overview and add active record counts by account/provider, readable storage inputs, and zero-source coverage; verify authenticated database/API fixtures include empty data, deleted records, and multiple sources without leaking content.
- [x] 1.2 Add current-revision/current-context distinct classification counts, zero categories, pending/stale totals, and independent poll/socket summaries; verify overlapping labels, stale runs, failed attempts after success, and manual Photos activity in database/API tests.
- [x] 1.3 Document Overview fields and storage/classification/freshness semantics in the operational API documentation; verify examples match tested response shapes and explain overlapping labels and physical database size.

## 2. Paginated operational history API

- [x] 2.1 Add immutable creation timestamps and ordering indexes for jobs/imports with approximate legacy backfills, then add shared validated filter/cursor handling and jobs history queries capped at 50 with deterministic tuple ordering; verify 0/50/51/101 rows, tied timestamps, arrivals between pages, invalid inputs, cursor/filter mismatch, retry/backoff without ordering changes, legacy backfill, and owner-only access in API/database tests.
- [x] 2.2 Add mixed job/import Failures history with type-specific sanitized metadata and applicable status filters; verify failed/expired membership, cross-type timestamp ties, pagination, absence of raw content/secrets, and unchanged retry deduplication and CSRF enforcement.
- [x] 2.3 Paginate the imports route and `photoStatus` list query before computing page progress, preserve single-session callers, and bound conversation settings to replacement pages of 50; verify imports beyond the old cutoff are reachable, progress remains accurate, and conversation pages do not overlap.
- [x] 2.4 Check query plans and add any further necessary additive indexes for history ordering/filtering; verify representative filtered queries use bounded page retrieval and document endpoint filters, cursor semantics, live-status limitations, approximate legacy creation dates, and coordinated web/API rollout.

## 3. Navigation and overview UI

- [x] 3.1 Introduce the responsive sidebar, hash routes, active-screen rendering, and navigation state; update browser fixtures to verify default Overview, direct links, reload, Back/Forward, narrow-screen menu, keyboard access, and absence of history tables on Overview.
- [x] 3.2 Render storage/record cards, source distribution, overlapping classification counts, and stage/freshness summaries with loading/error/empty states; verify zero denominators, relative and absolute timestamps, Photos exception, and independently degraded ingestion/indexing/socket health in browser tests.
- [x] 3.3 Move detailed Sources, Connections, Agent Access, and Personal Conversations into their screens while preserving OAuth callbacks, Picker popup behavior, credential lifecycle, and conversation edits; verify existing browser smoke actions through navigation and document screen locations.

## 4. History UI and refresh continuity

- [x] 4.1 Build Job History, Failures, and Photo Imports screens with source/status/date filters, cursor-stack Previous/Next, disabled boundaries, explicit refresh/newest controls, and at most 50 rendered entries; verify page replacement, empty filters, route persistence, and tied-timestamp navigation in browser tests.
- [x] 4.2 Scope refresh timers and guard stale responses across navigation/logout; preserve history position and filters after retries or progress updates; verify delayed responses, older pages during refresh, retry conflicts, expired Picker recovery, and logout clearing sensitive state.
- [x] 4.3 Update operator documentation for finding history, paging/filtering, interpreting overview counts, and recovering failures; verify documented paths and actions against browser scenarios.

## 5. Integrated verification

- [x] 5.1 Run `npm run typecheck`, `npm run build`, relevant API tests through `npm run test:db:isolated`, and `npm run test:ui`; record results and verify full-dataset aggregates remain independent of filtered 50-entry history pages throughout an authenticated end-to-end flow.

## Workflow follow-up

- Archive the MVP before this change, preserving both changes' additive `operations-dashboard` requirements; verify the resulting durable spec retains authentication, recovery, Photos behavior, aggregate statistics, and pagination requirements.
