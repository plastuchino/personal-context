# Design

## Context

The change started from a greenfield repository. The workspace, initial database/authentication foundations, and Gmail page adapter are now implemented; the unchecked tasks describe remaining work. See proposal.md for motivation and the six capability deltas for acceptance behavior. The application is for one owner and multiple explicitly authorized agent clients. Provider access and upstream freshness differ; Google Photos uses explicit selection rather than scheduled full-library synchronization.

## Goals / Non-Goals

**Goals:** Keep ingestion recoverable, separate source evidence from interpretations, enforce source permissions consistently, and expose pipeline freshness independently for ingestion, classification, and indexing.

**Non-Goals:** Arbitrary SQL over MCP, autonomous source actions, MCP task completion, full photo-library mirroring, face identification, and a general content browser. Direct image embeddings are deferred; visual descriptions and OCR provide initial photo semantic coverage.

## Decisions

### 1. TypeScript application with independent workers

Use a workspace with apps/web (Vite, Tailwind CSS, TypeScript), apps/api (Hono), apps/worker, and shared packages for database, connectors, classification, retrieval, and contracts. A Node.js runtime serves the API and workers. The dashboard calls authenticated Hono endpoints; the MCP endpoint is separately authenticated. A PostgreSQL-backed durable queue and scheduler avoid an additional broker for the MVP. Jobs are not tied to HTTP request lifetimes. A single process with in-memory cron was rejected because restarts would lose work and obscure recovery.

### 2. PostgreSQL schema and invariants

Use UUID internal keys, timestamptz for instants, date fields for all-day events, numeric for financial values, JSONB for original provider payloads, and migrations for all schema changes. The initial schema is:

| Table | Principal columns and invariants |
|---|---|
| source_accounts | id, provider, external_account_id, display_name, credential_ref, status; unique provider/account identity |
| sync_state | account_id, stream_key, cursor JSONB, coverage_start/end, last_attempt_at, last_success_at, source_watermark_at; unique account/stream |
| sync_jobs | id, account_id, stream_key, stage, status, scheduled_at, attempt, lease_until, started_at, finished_at, counts, redacted error; deduplicated active work |
| conversations | id, account_id, external_id, kind, title, personal_override; unique account/external identity |
| identities | id, account_id, external_id, email, display_name, is_self; no automatic cross-provider person merging |
| records | id, account_id, conversation_id, external_id, kind, source_url, source_created_at, source_updated_at, first_ingested_at, last_seen_at, deleted_at, current_revision_id; unique account/kind/external_id |
| record_revisions | id, record_id, revision_number, title, body_text, raw_payload, content_hash, captured_at; immutable content and unique record/revision number |
| record_participants | record_id, identity_id, role; composite uniqueness |
| email_details | record_id, message_id_header, in_reply_to, provider_labels |
| slack_message_details | record_id, channel_id, provider_message_ts, provider_thread_ts; provider timestamp IDs stored losslessly |
| calendar_event_details | record_id, starts_at, ends_at, timezone, start_date, end_date, all_day, recurrence_id, original_start, status |
| financial_accounts | id, source_account_id, external_id, type, currency, balance, balance_observed_at |
| financial_transaction_details | record_id, financial_account_id, amount, currency, merchant, pending, pending_external_id; explicit sign convention |
| photo_details | record_id, captured_at, mime_type, width, height, available_location, filename, media_asset_id |
| media_assets | id, record_id, sha256, mime_type, byte_size, bytes BYTEA, acquired_at; downloads bounded by configured size |
| derived_content | id, revision_id, kind, text, model_version, created_at; captions and OCR distinct from source text |
| classification_runs | id, revision_id, status, classifier_version, rules_version, evidence JSONB, confidence, classified_at, redacted error |
| record_labels | record_id, label, classification_run_id, reason, assigned_at; unique record/label and constrained five-value vocabulary |
| conversation_activity_daily | conversation_id, activity_date, self_message_count, total_message_count, coverage_complete; cached counts supplemented by timestamp-bounded record queries |
| tasks | id, title, description, status, requested_at, due_at, resolved_at, resolution_evidence_record_id; status open/done/uncertain |
| task_records | task_id, record_id, relationship; many-to-many evidence |
| record_chunks | id, revision_id, derived_content_id, chunk_index, content, start_offset, end_offset, search_vector; unique revision/chunk index |
| embedding_models | id, provider, model_name, dimensions, version |
| chunk_embeddings | chunk_id, embedding_model_id, embedding, embedded_at; unique chunk/model |
| agent_clients | id, name, credential_digest, created_at, revoked_at |
| access_grants | client_id, account_id; explicit source grants |
| retrieval_audit | id, client_id, tool, access_decision, occurred_at, returned_record_ids; no content or credentials |
| slack_event_inbox | id, account_id, team_id, event_id, envelope_id, event_ts, channel_id, message_ts, payload JSONB, received_at, processed_at, status, redacted error; unique account/event_id, account-constrained processing |
| slack_connection_state | account_id, team_id, authorized_user_id, status, connected_at, last_event_received_at, last_event_processed_at, gap_started_at, last_reconciled_at, coverage_complete; no app token or temporary socket URL |
| photo_import_sessions | id, account_id, provider_session_ref, status, expires_at, counts, redacted error |

Media bytes live in PostgreSQL for v1 to honor the requested storage boundary and simplify recovery; external object storage is an explicit future migration if volume requires it. Oversized or unsupported media fails visibly rather than claiming complete indexing. Video visual/audio analysis is not required in v1; selected videos retain available metadata and receive metadata embeddings with limited-analysis coverage disclosed.

Record, revision, account, and evidence references are checked transactionally to prevent cross-account association mistakes. All source timestamps preserve nulls when unavailable. Internal record URIs encode record/revision/chunk identity and resolve through MCP tools under the same authorization as search. Historical revision access remains authorized and does not make tombstoned data appear in normal search.

### 3. Transactional incremental ingestion

Schedule one enabled account/stream check every 15 minutes using a durable due time. Claim jobs with leases and stream locks; recover expired leases and use bounded exponential backoff with provider Retry-After handling. Commit records, observed revisions, downstream jobs, and page checkpoint together. Use hashes to avoid unchanged revisions. Distinguish empty successful polls from source-watermark advances. Photos jobs are created only after owner selection.

Gmail uses initial bounded message retrieval followed by history synchronization, including sent messages and thread reply references. Calendar uses per-calendar synchronization and preserves recurrence/cancellation semantics. Slack uses Web API backfill/reconciliation plus Events API delivery through Socket Mode as detailed below; access, event-delivery, and retention limitations remain visible. A seven-day message window is required before claiming complete participation coverage. Invalid cursors trigger controlled rebuilds, not deletion based on an incomplete page.

Use a financial-provider adapter with Plaid as the initial candidate for Capital One transactions/account context. Verify actual institution, account, product entitlement, authorization, and refresh support before accepting this connector; sandbox success alone is insufficient. Poll incremental available data every 15 minutes without promising equivalent bank freshness or automatically buying refresh capacity. Preserve pending-to-posted associations and handle updates/removals. No bank-website credential scraping. Connection feasibility is a release gate, not grounds to silently drop Capital One scope.

Initial backfill defaults to a configurable 30-day range for messages/transactions where available and calendar past 30/next 90 days; calendar synchronization must account for its provider's query/token constraints. These are proposed operational defaults, not claims of complete life history. Dashboard and MCP disclose actual coverage.

### 3a. Slack events with scheduled reconciliation

Use Slack Events API over Socket Mode for message creation, replies, edits, and deletions, alongside the existing 15-minute Web API jobs. Timestamp polling alone misses changes to older messages and deleted items disappear from history. Repeated full-history polling was rejected because it is expensive and cannot establish every historical change. Socket Mode avoids requiring a public inbound webhook; it adds a persistent outbound connection and an app-level token.

Configure the Slack app with Socket Mode, an app-level token limited to `connections:write`, and user message subscriptions for the authorized public/private channels and direct/group messages. Existing user OAuth credentials continue to govern Web API access. The app token is a separate encrypted deployment/connection secret, never an agent credential. Use Slack's Node Socket Mode SDK for connection lifecycle and envelope acknowledgments. Do not add message-send scopes or source mutation tools.

Validate the app/workspace/installation authorization mapping before associating an event with a source account. A shared workspace ID alone is insufficient for routing private events to multiple connected users. Ignore unsupported or unauthorized event types without exposing their content in logs. Persist an accepted event in `slack_event_inbox`, unique on `(account_id,event_id)`, and its processing job in one transaction before acknowledging the envelope. Acknowledgment means durable receipt, not completed classification or indexing. Duplicate deliveries are acknowledged after confirming the existing durable row; a database failure must not produce a successful acknowledgment. Keep receipt within Slack's acknowledgment deadline and move processing to workers.

Process inbox work through the same stream serialization as reconciliation. Preserve Slack message timestamps as lossless identifiers and use provider event/edit timestamps for ordering. Apply record changes, inbox completion, and downstream classification/embedding work atomically. Discard obsolete updates; delayed history pages or retried creation events must not restore a message already deleted by newer evidence. Store deletion version evidence even when a delete arrives before its original message. Invalidate current search chunks and refresh participation/task context when source content changes.

Reconnect with bounded backoff, handle socket refresh/disconnect notifications, and expose missing token/subscription, revoked authorization, rate limiting, inbox backlog, and reconnect status. Record a coverage gap after a lost connection or reported delivery limitation; a quiet channel does not itself indicate a broken connection. `last_event_received_at` and `last_event_processed_at` are separate from scheduled check success and provider content timestamps.

The 15-minute jobs enumerate authorized conversations, backfill the configured history range, revisit tracked threads (including threads whose parent predates the recent-message cursor), and reconcile accessible messages in explicitly recorded coverage ranges. Recover available changes after outages and expose unrecoverable historical gaps. Do not infer deletion from an incomplete page, lost access, or retention filtering. Clear a gap only for ranges actually reconciled; a reconnected socket or an empty successful poll does not prove complete history. Socket delivery is not assumed lossless and does not replace backfill/reconciliation.

The dashboard and MCP source-status response expose Slack connection health, event/inbox lag, last reconciliation, and incomplete coverage using the existing operational visibility and freshness contracts. App-token setup is owner-only; MCP remains read-only.

References: [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/), [message edits](https://docs.slack.dev/reference/events/message/message_changed/), [message deletions](https://docs.slack.dev/reference/events/message/message_deleted/).

### 4. Photos OAuth and Picker

The owner connects via OAuth, creates a Picker session in the dashboard, selects items in Google Photos, and sees import progress. The backend retrieves only selected items and downloads bytes while authorized URLs remain valid. Persist source identity and deduplicate repeated selections. Refreshing OAuth alone does not grant access to unselected future photos. Session/download expiration requires a visible retry or new selection. Never persist expiring download URLs as permanent citations.

Photo processing extracts available metadata, OCR, and a vision-generated description through configurable services. Store original metadata, OCR, and inferred descriptions separately; captions are interpretations, not verified facts. No inferred face identity or face clustering. The provider permalink is nullable; the internal record URI is always the citation fallback.

### 5. Classification and task evidence

Apply deterministic relationship and participation rules first, then a structured-output classifier for semantic attention labels and task candidates. Version rules and models, validate outputs, and retry failures. Personal and blocking can overlap; background must not suppress a supported blocking or update label. Unorganized marks failed processing and is removed after successful retry. Newly queued work is pending, not falsely classified as failed.

Group personal status uses a rolling seven-day window at classification time: explicit override OR at least five owner messages OR a nonzero total with owner/total >= 0.10. Use exact timestamp boundaries rather than seven whole daily buckets. Reevaluate affected group records after messages, edits, deletions, overrides, and daily window expiry; preserve historical classification runs and disclose incomplete coverage. Initial v1 interpretation applies this group rule to channel/group-message records; direct response relationships remain independently personal.

Extract tasks with supporting record/revision references and consolidate follow-ups conservatively. Mark done only when later source evidence establishes resolution; ambiguous conclusions remain uncertain, and due dates do not prove completion. MCP never mutates task status. The owner can set conversation overrides through operational settings, without adding a personal-content inbox.

### 6. Hybrid retrieval and indexes

Chunk normalized text and derived photo text by semantic boundaries with bounded overlap. Preserve character offsets within the referenced text or derived artifact. Queue classification and embedding independently. Content-free records receive a deterministic textual rendering of structured fields, so all supported records have an embedding input. Failed analysis/indexing remains visible.

Use PostgreSQL full-text search with a GIN tsvector index, pgvector cosine similarity with a compatible-dimension HNSW index, and B-tree indexes on external identities, account/date, participants, labels, task status, and typed source details. Pin one configured embedding model/dimension for the initial index; model changes create a separate version/index and rebuild before switching. Never compare incompatible vectors.

Apply authorization, current-revision, tombstone, and exact filters within each candidate query before ranking. Combine keyword and semantic rankings using reciprocal rank fusion, deduplicate chunks/records, and cap/page results. Exact lookup bypasses ranking. Expose degraded semantic coverage when embeddings are unavailable while retaining keyword/exact paths. Current search excludes superseded chunks immediately, even if the replacement is still indexing.

### 7. Authentication and MCP boundary

Use a single-owner dashboard login with secure, HttpOnly, SameSite cookies, password hashing, CSRF protection, and TLS in deployed environments. Provider OAuth callbacks validate state and bind to the owner session. Encrypt provider refresh credentials using a deployment secret outside the database; credential_ref points to encrypted credential storage. Redact tokens, source bodies, download URLs, and raw provider errors from logs.

For v1, provision high-entropy per-agent bearer credentials through owner-only settings, store only digests, and require explicit account grants. This requires an MCP client capable of configured bearer headers; standards-based authorization discovery can be added later without widening tool permissions. Expose search_context, get_record, get_revision, list_blocking_tasks, and get_source_status. All content responses carry the provenance envelope and freshness/coverage indicators.

Use a dedicated read-only database role for personal-data MCP queries through grant-filtered retrieval views/functions. Do not permit arbitrary SQL. Recheck grants on each request, including citation resolution and exact IDs. A separate narrow append-only audit writer records retrievals; this operational logging exception cannot mutate source data, labels, or tasks. Worker and dashboard mutation credentials are not available to MCP handlers. Denied/missing IDs have indistinguishable external errors. Source content is untrusted input to classifiers and retrieval consumers.

### 8. Operations and verification

Expose job history, leases, stage-specific backlog, database size, source check/watermark times, coverage, authorization expiry, failure summaries, and retry controls. Photo import and connection/client settings are the only setup flows beyond monitoring; do not build a general inbox. Operator retries use the same queue deduplication as scheduled work.

Verify behavior using PostgreSQL integration tests for transactionality, search and permissions; provider fixtures for cursor resets, rate limits, edits, and deletion; classification boundary cases; and authenticated API/MCP tests. Live smoke checks are required for actual authorized providers and clearly separated from fixture/sandbox evidence. UI smoke checks cover OAuth/Picker errors, dashboard health, and owner-only controls.

## Risks / Trade-offs

- Provider access/freshness limitations -> Show real coverage and upstream watermarks; verify Capital One live connectivity before connector acceptance.
- Slack event outages, duplicate/out-of-order deliveries, and retention gaps -> Persist before acknowledgment, serialize updates with reconciliation, retain deletion ordering evidence, and expose unrecoverable coverage gaps.
- Media growth and sensitive backups -> Track total/media database size, bound downloads, encrypt storage/backups, document restore and deletion procedures.
- Model errors or source prompt injection -> Preserve evidence and uncertainty, validate outputs, and enforce permissions outside model decisions.
- PostgreSQL does queue, storage, and search work -> Bound concurrency and monitor query/queue latency; separate infrastructure only after measured pressure.
- Reclassification and embedding cost -> Hash content, reuse unchanged outputs, batch work, and expose costs/backlog before backfill expansion.
- Imported photo metadata varies -> Keep missing fields explicit and avoid promising provider permalinks, location, or capture time.

## Migration Plan

1. Establish local services and reversible schema migrations; no legacy records exist.
2. Configure owner authentication, secret encryption, and source-scoped agent credentials before exposing personal data.
3. Enable one connector at a time with a bounded backfill, verify coverage, then enable scheduled checks. Before enabling Slack events, apply additive inbox/connection-state migrations and configure app-token storage and event subscriptions; connect Socket Mode and verify durable receipt, restart recovery, and scheduled reconciliation.
4. Enable classification and search indexes, then read-only MCP and dashboard visibility.
5. Run provider smoke checks, backup/restore verification, and permission checks before deployment acceptance.

Rollback stops workers and revokes endpoint access, then rolls back application release while retaining source data. Destructive down migrations are not an automatic rollback strategy. Derived indexes can be rebuilt from revisions; credentials and media require explicit backup handling.

## Open Questions

- Which hosting environment and final deployment hostname will supply TLS and secret management?
- Which configurable embedding, classifier, and vision models meet the owner's cost and data-processing preferences? Select and pin versions before generating production derived data.
- Which initial backfill ranges should replace the documented defaults for the owner's actual accounts?

These choices change deployment values and data coverage, not the capability contracts or component boundaries.
