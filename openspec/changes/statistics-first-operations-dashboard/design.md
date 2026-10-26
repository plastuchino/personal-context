# Design

## Context

See proposal.md for motivation. `apps/web/src/main.ts` currently mounts every panel together and refreshes Overview and imports every five seconds. `operations.ts` mixes aggregates with 100 recent jobs; conversations append batches of 100. `photo-status.ts` limits imports to 50 without navigation and orders by expiration time. Existing browser fixtures assume all controls appear together. Owner middleware and CSRF checks already protect operations.

The durable spec inventory is empty. The in-flight MVP already owns `operations-dashboard`; this change adds distinct requirements under that same path and preserves its recovery and visibility contracts. Archive MVP first, then merge these additions without replacing its requirements.

## Goals / Non-Goals

**Goals:** Bound history query/render work, separate aggregate reads from detail reads, preserve navigation and recovery behavior, and make statistics semantically accurate.

**Non-Goals:** Raw content browsing, provider or worker changes, per-source physical storage accounting, exact snapshots of mutable job status across pages, and a new frontend framework.

## Decisions

### 1. Route screens within the existing Vite application

Use hash routes for Overview, Sources, Logs/Jobs, Logs/Failures, Logs/Imports, and Settings subsections for Connections, Agent Access, and Personal Conversations. Hash routing provides direct links and browser history without deployment fallback configuration or another dependency. Render only the active screen in a responsive sidebar/content shell; collapse navigation on narrow screens. Sources holds detailed stream/socket coverage; Overview has compact source summaries and links. Connections retains setup and Picker launch; Imports retains selection/progress context. Keep conversation settings bounded to 50 with replacement pagination rather than accumulating rows.

### 2. Separate aggregate and history contracts

Keep `/api/operations/overview` for aggregate storage, records, source distribution, classifications, stage counts, and compact freshness/health only; remove its job rows. Add `/api/operations/jobs` and `/api/operations/failures`, and paginate `/api/photos/imports`. Failures combines failed job rows and failed/expired import sessions, identified by entry type; retry applies to eligible jobs, while expired imports link to choosing photos again. Use sanitized error codes and operational metadata only. Reuse the Photos progress calculations on the selected page, keeping single-session status callers compatible.

All history endpoints return at most 50 items plus `next_cursor`; use a 51st row only to detect continuation. Standardize optional `source` (account ID), `status`, `from`, and `to` filters; UTC timestamps use inclusive start/exclusive end. Validate UUIDs, timestamps, status vocabulary, date ordering, and bounded cursor structure. Each endpoint enforces its own cap regardless of caller inputs. Failures status vocabulary is restricted to failed/expired states applicable to each type.

### 3. Cursor pagination with stable ordering

Add immutable `created_at` columns to jobs and import sessions in an additive migration: jobs currently mutate `scheduled_at` during retry/backoff, and imports have no creation timestamp. Backfill jobs from their existing scheduled timestamp and imports from expiration time as an explicitly approximate historical ordering; new rows default to insertion time. Order jobs and imports by `(created_at DESC, id DESC)`, and mixed failures by creation timestamp, entry type, and ID. Add supporting indexes. Do not order history by mutable scheduled, expiration, or completion times. Date filters use these creation timestamps; document approximate dates for legacy rows. Encode the last sort tuple and filter identity in a versioned opaque cursor and validate before binding SQL parameters. Reject cursor/filter mismatches. The client keeps a cursor stack for Previous and persists screen/filter/cursor state in the hash for reloads and Back/Forward. A direct link without prior-page state offers return to newest.

Offset pagination was rejected because new jobs shift older pages. Cursor paging avoids arrival-related shifts but does not freeze mutable statuses: rows may leave a filtered page after retry. An explicit refresh reloads the same cursor; if it becomes empty, show that state and return controls rather than silently jumping elsewhere. No total-page count is promised.

### 4. Compute aggregates independently

Count active records with `deleted_at IS NULL`; retain deleted totals separately if useful. Group counts by provider and account, join connected sources so zero-record accounts remain visible, and calculate source shares against active totals. Display physical database bytes and media bytes in readable units; media is included in database storage, not additive. Do not invent per-source physical byte figures.

For labels, join classification runs matching current revision and context version, count distinct active record IDs per label, and include all five categories at zero when absent. Pending/stale is the number of active records without a current completed classification or current terminal unorganized result. Classifications overlap and are not a partition; avoid a pie chart that implies exclusive categories. Preserve stage-specific failure/backlog and per-stream freshness so one success cannot hide another stream's failure. Distinguish attempt, success, and provider watermark; show relative ages with absolute timestamps available. Photos uses import activity and an explicit manual-import indicator. Preserve Slack socket/inbox/gap signals in Sources with a compact Overview indicator.

### 5. Refresh only what the owner is viewing

Overview may retain the five-second refresh with cancellation/sequence guards against stale responses after navigation. History pages load on navigation, filters, paging, or explicit refresh; they do not auto-replace rows. Show a refresh/newest action. After retry, refresh the same page and relevant aggregate state. Import progress refresh is limited to explicit active-session detail or first-page progress without resetting filters/cursors; older pages remain stable. Clear timers and sensitive credential state on logout. Retain accessible headings, table labels, navigation state, keyboard controls, and explicit loading/error/empty states.

## Risks / Trade-offs

- Aggregate scans increase with records -> use grouped SQL and existing indexes; inspect query plans with realistic fixtures and add narrowly justified indexes if necessary.
- API shape changes affect web fixtures -> ship API/web together and update integration/browser contracts in the same change.
- Concurrent status changes alter filtered membership -> document live history behavior and test cursor continuity under arrivals separately from status changes.
- Two active changes share one capability -> preserve MVP requirements and apply these additive deltas after MVP during archival; do not edit MVP planning artifacts here.

## Migration Plan

Implement authenticated aggregate/history queries, then switch the web shell and fixtures together. Apply additive creation-timestamp columns, legacy backfills, and supporting indexes. Run isolated database/API tests, browser checks, type checking, and build before release. Roll back API and web together; retain source data and additive timestamp columns/indexes. No records, labels, or job history are rewritten by this change.
