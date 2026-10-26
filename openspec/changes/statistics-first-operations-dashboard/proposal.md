# Proposal

## Why

The operations dashboard renders detailed history and settings together, making the front page grow and obscuring aggregate health. The owner needs a compact statistical overview and separate, bounded screens for operational history.

## What Changes

- Introduce sidebar navigation inspired by the supplied CloudWatch layout: Overview, Sources, Logs (Job History, Failures, Photo Imports), and Settings.
- Make Overview display human-readable database/media sizes, active record totals and source distribution, classification counts, pipeline backlog, and per-source poll freshness.
- Move operational history to dedicated screens with server-side pagination capped at 50 entries and Previous/Next controls; filters and refresh must preserve browsing position.
- Keep connection, Photos selection, agent, and conversation controls accessible in their relevant screens.
- Exclude browsing raw ingested content, new ingestion behavior, and changes to classification semantics.

## Capabilities

### New Capabilities

- `operations-dashboard`: Statistics-first navigation, aggregate visibility, and bounded operational history. This reuses the capability path already declared by the in-flight `personal-context-mvp` change; no durable main specs exist yet. These additive requirements complement that change's owner access, recovery, and Photos requirements rather than redefining them.

### Modified Capabilities

None in the durable spec inventory. Coordinate archival with the in-flight MVP so both sets of requirements are retained under `operations-dashboard`.

## Impact

Affects `apps/web/src/main.ts`, web styles, `apps/api/src/operations.ts`, the Photos imports route in `apps/api/src/app.ts`, and `packages/database/src/photo-status.ts`. Updates authenticated API/database and browser tests plus operational documentation. Overview stops including job rows; web and API changes must ship together. No new provider permissions or runtime dependencies are expected.
