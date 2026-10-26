# Proposal

## Why

Personal context is fragmented across communication, calendar, financial, and photo services. A searchable, attributable personal data service will let authenticated agents retrieve current context and outstanding requests without requiring repeated explanations or granting them authority to act.

## What Changes

- Introduce PostgreSQL-backed source records, revisions, provenance, structured fields, search chunks, and vector embeddings.
- Ingest Gmail, accessible Slack conversations, Google Calendar, and Capital One financial data through scheduled incremental jobs every 15 minutes, distinguishing polling frequency from provider freshness.
- Receive Slack message, reply, edit, and deletion events through Socket Mode, retaining 15-minute backfill/reconciliation jobs and exposing event-connection gaps.
- Support Google Photos OAuth and user-initiated Picker imports in the dashboard; Photos is exempt from unattended polling.
- Assign overlapping personal, background, blocking, and update labels; reserve unorganized for classification failures. Preserve evidence and classification versions.
- Provide semantic, keyword, and exact retrieval through authenticated, source-scoped, read-only MCP tools, with per-result source identifiers, links when available, and timestamps.
- Add an authenticated Vite, Tailwind CSS, and TypeScript dashboard backed by Hono for connection setup, photo imports, job health, database size, errors, and retries.
- Exclude MCP mutations, task completion, outbound actions, automatic whole-library Photos synchronization, and a general personal-content browsing UI from v1.

## Capabilities

### New Capabilities

- `source-ingestion`: Authorized connectors, scheduled reconciliation, durable Slack event ingestion through Socket Mode, and Photos Picker imports.
- `personal-data-storage`: Canonical records, source-specific details, immutable revisions, and attributable retrieval units.
- `context-classification`: Overlapping labels, participation rules, classification evidence, and outstanding-request tracking.
- `hybrid-retrieval`: Vector, keyword, and exact search with filters, index freshness, and provenance.
- `agent-access`: Authenticated, source-scoped, audited, read-only MCP retrieval.
- `operations-dashboard`: Owner access, connector setup, Photos imports, pipeline monitoring, and recovery controls.

### Modified Capabilities

None; the project has no existing capability specs.

## Impact

This is a greenfield application in the current repository. It introduces a TypeScript web/API/worker application, PostgreSQL with pgvector, provider OAuth integrations, a Slack Socket Mode connection and durable event inbox, a financial-data adapter, and configurable embedding/vision/classification services. Slack setup additionally requires an app-level Socket Mode token and event subscriptions; no public event webhook is required. Provider credentials and live account access are external prerequisites; Capital One connectivity must be verified before its connector is accepted. No existing application behavior or migration compatibility is affected.
