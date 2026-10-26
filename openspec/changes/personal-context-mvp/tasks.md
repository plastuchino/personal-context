# Tasks

## 1. Application foundation

- [x] 1.1 Create the TypeScript web/API/worker workspace and shared contracts; verify dependency installation, type checking, and a Vite production build.
- [x] 1.2 Add local PostgreSQL with pgvector, configuration validation, and service startup instructions; verify a clean local startup using the documented commands.
- [x] 1.3 Define configurable model adapters, pinned model/dimension settings, download limits, and backfill ranges; verify invalid configuration fails before workers start and document the defaults.

## 2. Canonical data and jobs

- [x] 2.1 Add migrations for source accounts, streams, jobs, records, revisions, identities, conversations, and typed source details; verify a fresh database migrates and uniqueness/revision constraints pass integration tests.
- [x] 2.2 Add media, derived-content, classifications, labels, tasks, chunks, embeddings, import-session, client/grant, and audit tables with required indexes; verify decimal precision, all-day dates, and account-consistent references in PostgreSQL tests.
- [x] 2.3 Implement transactional upserts, revision hashing, tombstones, and provenance serialization; verify duplicate ingestion, edits, missing source links, and immutable revision citations.
- [x] 2.4 Implement durable scheduling, per-stream leases, checkpoint transactions, retries, and downstream job creation; verify crash/replay, expired lease, rate-limit backoff, and simultaneous retry scenarios.
- [x] 2.5 Document schema invariants, coverage semantics, migration commands, and queue recovery; verify commands against a clean database.

## 3. Authentication and connection controls

- [x] 3.1 Implement owner login/session storage, password hashing, CSRF protection, and encrypted credential references; verify unauthorized requests, forged mutations, invalid OAuth state, and credential redaction tests.
- [x] 3.2 Implement agent credential issuance, revocation, source grants, and a read-only retrieval database role with a separate append-only audit writer; verify an agent cannot mutate records or use dashboard endpoints.
- [x] 3.3 Add provider OAuth connection/reauthorization endpoints and setup documentation; verify callback failures leave recoverable connection states without exposing tokens.

## 4. Scheduled source connectors

- [x] 4.1 Implement Gmail bounded backfill, sent-message identity, thread relationships, history sync, and cursor reset handling; verify reply, deletion, duplicate page, and expired-history fixtures and document required scopes.
- [x] 4.2 Implement authorized Slack Web API conversation/message/thread backfill and coverage reporting; verify inaccessible channels, pagination, and incomplete seven-day coverage fixtures and document access/retention limits.
- [x] 4.3 Add additive Slack event-inbox and connection-state migrations, installation/account routing, durable receipt/job creation, and per-account event deduplication; verify duplicate delivery, unauthorized installation, database failure before acknowledgment, and crash-after-receipt recovery tests.
- [x] 4.4 Add Slack Socket Mode lifecycle and owner-only app-token configuration with required event subscriptions; verify acknowledgment after commit, socket refresh/reconnect, revoked/missing credentials, and token-redaction tests, and document local setup without a public webhook.
- [x] 4.5 Integrate event processing with serialized source updates and 15-minute reconciliation, including tracked older threads, event-version ordering, deletion evidence, and coverage gaps; verify edits/deletes, stale-page resurrection prevention, missed replies, outage recovery, and retention-limited recovery fixtures, and document recovery semantics.
- [x] 4.6 Implement Calendar synchronization with recurrence, cancellation, timezones, and all-day fields; verify incremental tokens, reset handling, recurring instances, and boundary-date fixtures and document coverage settings.
- [ ] 4.7 Verify Capital One production connection feasibility through the selected financial provider and record supported account types, entitlements, and freshness; completion requires actual authorized connectivity evidence, not sandbox-only results.
- [x] 4.8 Implement the verified financial adapter, accounts, incremental transactions, removals, and pending-to-posted linkage; verify replay/update fixtures and document decimal/sign conventions and freshness limits.
- [x] 4.9 Wire all four enabled connector types to 15-minute scheduling alongside Slack event ingestion; verify independent-stream failure recovery, shared stream serialization, and check-time versus source-watermark reporting in an integration run.

## 5. Google Photos imports

- [x] 5.1 Implement OAuth-bound Picker session creation, selection polling, expiration handling, and import jobs; verify only selected items are ingested and expired sessions fail recoverably.
- [x] 5.2 Download selected media into bounded PostgreSQL media storage with source identities and repeated-selection deduplication; verify expired URLs, oversized files, and duplicate imports with fixtures.
- [x] 5.3 Add metadata extraction, OCR, and vision descriptions with separate derived provenance; verify a receipt image yields searchable text, inferred descriptions are marked, and failed analysis remains observable.
- [x] 5.4 Document Photos selection workflow, metadata limitations, media bounds, and metadata-only video coverage; verify the described import can be completed in an authorized smoke check.

## 6. Classification and requests

- [x] 6.1 Implement owner/action response rules, explicit conversation overrides, and exact rolling-seven-day participation calculations; verify five-message, 10-percent, zero-total, incomplete-window, and expiry boundary cases.
- [x] 6.2 Implement validated overlapping semantic labels, versioned classification runs, failure retries, and unorganized recovery; verify personal-plus-blocking, newsletters, payment updates, pending state, and outage fixtures.
- [x] 6.3 Implement evidence-backed task extraction, conservative consolidation, and source-evidenced resolution; verify multiple requests per message, follow-ups, uncertain resolution, and overdue-but-open tasks.
- [x] 6.4 Implement reclassification scheduling for changed records and conversation relevance changes; verify updated evidence does not leave stale labels presented as current and document label/task semantics.

## 7. Hybrid retrieval

- [x] 7.1 Implement revision-bound chunking, structured-field text rendering, embedding generation, and model-version isolation; verify offsets, all-record indexing eligibility, retries, and incompatible-dimension rejection.
- [x] 7.2 Implement indexed keyword and semantic queries, exact filters, rank fusion, pagination, and tombstone/current-revision filtering; verify paraphrase retrieval, exact amounts/IDs, stale chunk exclusion, and keyword fallback during embedding outages.
- [x] 7.3 Implement source-grant filtering before candidate ranking across all retrieval paths; verify unauthorized content, counts, evidence, and historical citations never leak in cross-account tests.
- [x] 7.4 Document query/filter contracts, citation envelopes, index rebuilds, and coverage indicators; verify sample queries and citation resolution against seeded records.

## 8. Read-only MCP

- [x] 8.1 Expose authenticated search_context, get_record, get_revision, list_blocking_tasks, and get_source_status tools; verify every content-bearing result and task evidence carries provenance and freshness.
- [x] 8.2 Add retrieval audit, uniform denied/missing lookup behavior, revoked-client checks, and bounded inputs; verify audit redaction, direct-ID bypass attempts, malicious source instructions, and read-only task behavior.
- [x] 8.3 Document bearer-header client setup, source grants, and unavailable mutation operations; verify a configured MCP client searches and resolves a citation while task-completion attempts cannot change data.

## 9. Operational dashboard

- [x] 9.1 Build authenticated Vite/Tailwind operational views for database size, job history, coverage, source freshness, authorization, stage backlog, and errors, including Slack socket health, event/inbox lag, last reconciliation, and coverage gaps; verify ingestion success, indexing failure, and event-delivery degradation display independently.
- [x] 9.2 Add connection setup, reauthorization, agent grants/revocation, and explicit personal-conversation settings; include Slack app-token/subscription readiness without exposing secrets; verify owner-only controls and persisted settings through API/UI checks.
- [x] 9.3 Add Photos selection/import progress and retry controls; verify expired selection recovery, downloaded-versus-indexed status, and active-stream retry deduplication.
- [x] 9.4 Document operational troubleshooting and the Photos scheduling exception; verify documented recovery steps against failed fixture jobs without exposing source bodies or secrets.

## 10. End-to-end acceptance

- [x] 10.1 Run source-to-MCP integration scenarios spanning ingestion, edits/deletions, classification, embeddings, citations, and grant revocation; verify all six capability contracts and retain results.
- [ ] 10.2 Complete authorized live smoke checks for Gmail, Slack, Calendar, Capital One, and Photos Picker, including Slack event delivery and reconnect/reconciliation recovery; record actual coverage and provider limitations separately from fixture results, leaving unavailable checks incomplete.
- [x] 10.3 Exercise worker restart and backup/restore including media and encrypted credential recovery; verify records retain identity and retrievable citations after restoration.
- [x] 10.4 Run build, type checking, relevant tests, and dashboard/MCP smoke checks; deliver local/deployment instructions and record remaining deployment configuration and Slack Socket Mode setup without claiming an unperformed deployment.
