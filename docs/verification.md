# Implementation verification

Change: personal-context-mvp. Evidence recorded during local implementation on 2026-10-25. Provider/model coverage is separate from deterministic fixture tests. No production deployment is claimed.

## Automated checks

- TypeScript type checking and Vite production build pass.
- 42 unit tests pass; database cases skip in the default unit command and run separately below.
- 32 PostgreSQL integration tests pass on unique temporary databases, including classification/recovery, hybrid retrieval/permissions, an actual MCP SDK client, Photos recovery, and backup/restore.
- Browser smoke checks pass with mocked API/provider responses: owner login/logout, safely rendered source names, Picker popup/navigation/fallback/failure cleanup, separate downloaded/indexed progress, retries, agent grants/revocation, and personal settings.
- Strict OpenSpec validation passes. Unavailable live acceptance gates remain unchecked.

Capability evidence:

| Capability | Verification |
| --- | --- |
| Source ingestion | Gmail/Slack/Calendar/financial provider fixtures, four-source scheduled ingestion, cursor/replay/lease failure cases, Slack events and reconciliation; authorized Photos selection/download also observed locally |
| Personal data storage | Immutable revisions/citations, exact financial numeric values, all-day dates, source/account-consistent references, PostgreSQL media bounds, deduplication, encrypted credentials |
| Classification | Personal-plus-blocking overlap, newsletters, payment updates, source-action quotes, group thresholds and expiry, pending/stale state, bounded failures/unorganized recovery, multiple requests, follow-ups and quoted source resolution |
| Hybrid retrieval | Revision-bound Unicode-safe offsets, OCR/description provenance, keyword fallback, model/dimension isolation, paraphrase vectors in fixtures, exact amount strings, tombstones, historical citations and pre-ranking grant filters |
| Agent access | SDK Streamable HTTP tool discovery/search/task/source status/citation resolution, indistinguishable missing/ungranted IDs, revoked clients, unsupported mutation attempts, audit redaction, read-only repeatable-read transactions and restricted job-status fields |
| Dashboard | Auth/CSRF checks and persisted settings against PostgreSQL; mocked browser operational/connection/Picker/grant/override controls; actual loopback dashboard/API/proxy health |

The source-to-MCP scenario processes source fixtures through classification/task extraction, embeddings, search, task evidence and exact citation resolution; edits/deletions immediately exclude old chunks from ordinary search while historical citations resolve. Revocation and unsupported task-completion attempts leave task data unchanged. Other provider-specific semantics are exercised in their integration/fixture cases rather than represented as live authorized accounts.

## Actual local checks

- Plaid Sandbox account/transaction ingestion has run. An actual SDK client connected to the running local MCP endpoint, discovered five tools, retrieved/resolved a Sandbox source citation, and was rejected after its temporary credential was revoked. Source bodies and credentials were not logged.
- Google Photos OAuth, owner Picker selection, selected-media downloading, and analysis have run on owner-authorized items. A generated description from an actually selected photo resolved through the running MCP endpoint with exact revision/chunk provenance, model version, interpretation marker, and classification state. The single-item import session is now done (one selected, downloaded and completed item, zero failures). This provides the authorized completed import smoke check. The separate 177-item batch continues asynchronously and is not claimed complete.
- Ollama 0.40.7 is installed as a local Homebrew service. Cloud features are disabled in its private server configuration and were verified in the startup log. Installed embeddinggemma:latest and gemma3:4b digests are pinned privately. Live synthetic checks passed for 768-dimensional vectors, newsletter classification, two distinct quoted requests, and receipt description/OCR. Initial invented resolutions were rejected; the corrected task schema allows only supplied existing IDs and requires no resolutions when none exist.
- Live local semantic search through MCP passed with the configured embedding service. Photo description evidence is explicitly marked a model interpretation. Actual source text was not included in verification output.
- New database migrations were applied locally and the API/worker restarted with model settings enabled. Separate ingestion lanes prevent model calls from consuming ingestion worker capacity. Missing-configuration photo failures were requeued as their original jobs, under normal stream locks and bounded retry cycles.

## Recovery and limits

The selected Photos batch remains in progress. Four oversized video downloads exposed an implementation bug: v1 only needs their metadata. The corrected importer bypasses video byte download, retaining metadata-only coverage. A JPEG completed local inference in about 65 seconds, exposing the initial 60-second model timeout; vision now defaults to 180 seconds. The four video records have recovered with metadata-only coverage. The corrective JPEG job and all four video jobs have now completed successfully. The remaining large-batch image analysis continues with the longer timeout, without discarding stored media. Completed downloads, analysis, keyword indexing, classification and configured-model embeddings are separate counts. Retrying stored-byte analysis does not require an unexpired Picker session. Processing a successful selected item does not assert that every selected file or every model interpretation succeeded.

The backup/restore check simulates worker lease expiry, dumps a fixture-only temporary database, restores into another unique database, and verifies media bytes, encrypted credential decryption, agent authentication and exact chunk citation identity. The owner database was never replaced. The local dump/restore check is enabled only for the documented Compose test server.

Gmail and Calendar are now owner-authorized. Calendar completed successful source checks and ingested events. Gmail ingested messages, hit repeated provider errors during initial backfill, and its next-page diagnostic read succeeded. Initial Gmail backfill remains incomplete. Remaining live gates: Capital One production connectivity and Slack event delivery, including socket reconnect/reconciliation; complete the combined source smoke check only after those and Gmail backfill verification. Google Photos and local model success do not substitute for those accounts. The production hostname/TLS/hosting environment and deployment secret management are not configured.

On 2026-10-26, Slack owner OAuth succeeded through the local HTTPS callback. Web API ingestion imported over 1,700 records and completed reconciliation jobs. The Socket Mode receiver was started, but the owner app-level token is not yet configured; no live event delivery or reconnect recovery is claimed. Gmail imported 1,500 records but has no completed mailbox check. Provider HTTP failures now retain fixed status codes and distinguish Google 403 rate limits, daily quota and domain policy errors without retaining provider messages. Focused error mapping tests and the full unit suite passed (42 unit checks, 32 database checks skipped in that command), as did type checking. Existing failed jobs keep their original error codes.

## Statistics-first operations dashboard (2026-10-26)

Implemented the Overview/sidebar separation and dedicated Job History, Failures, and Photo Imports screens with server-side 50-entry cursor pages. Authenticated PostgreSQL/API fixtures verify active/deleted source totals, zero-record sources, overlapping current classifications versus stale/pending results, manual imports, poll attempt/success separation, owner-only history access, CSRF retry restrictions, tied microsecond timestamps, concurrent arrivals, filter/cursor validation, page replacement contracts, single-session import compatibility, and full-dataset statistics independent of history pages. A committed migration fixture verifies approximate legacy timestamps, immutable new timestamps, and indexed bounded retrieval with analyzed multi-source data.

Validation passed: `npm run typecheck`, `npm run build`, `npm run test:db:isolated` (32 tests, no failures or skips), and `npm run test:ui`. The browser test covers direct routes, reload and Back/Forward, all three history page boundaries, filters and empty/error states, stable older pages, stale-response guards, retry conflicts, Picker popup/fallback/failure recovery, agent credentials/revocation, conversation controls, and narrow-screen keyboard navigation without horizontal overflow. Desktop and mobile fixture screenshots were reviewed. Browser provider responses are mocked; these checks do not assert new live provider authorization or ingestion coverage. Migration 017 was applied to the local project database; no external deployment was performed.

Overview performance recovery: with 3,116 enabled streams, the latest-ingestion-job lookup was taking tens of seconds and overlapping requests accumulated. Migration 018 adds the matching partial index on account, stream, creation time and ID for ingestion jobs. The live index was built concurrently to avoid blocking active backfill writes, then the migration was recorded. Two authenticated live Overview calls returned HTTP 200 in 266 ms and 195 ms with 8,223 records. A 10,000-job, 2,000-stream regression checks the actual query plan uses the stream index without filtering unrelated streams. The existing browser refresh already prevents overlapping automatic refreshes within a screen.
