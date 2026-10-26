# Personal Context

Personal context infrastructure with a Vite/Tailwind/TypeScript dashboard, Hono API, independent workers, and PostgreSQL. Implementation is tracked in `openspec/changes/personal-context-mvp/tasks.md`.

## Development

Use Node.js 24 and npm 11. From the repository root:

```sh
npm ci
npm run dev:api
```

In separate terminals run `npm run dev:web` and `npm run dev:worker`, then open http://127.0.0.1:5173. Set your owner password using `npm run owner:setup`. The API defaults to port 3000; the current local `.env` uses 3001 to avoid a port conflict. Vite reads the configured API port. `/health` exposes liveness only; operational endpoints require owner authentication.

Implemented: PostgreSQL/pgvector storage and durable workers; Gmail, Slack, Calendar, financial and selected-Photos ingestion; overlapping classification and evidence-backed requests; keyword/semantic/exact retrieval; source-scoped read-only MCP; and an owner operations dashboard. Configured model stages run independently from source ingestion. Missing embedding models leave keyword/exact retrieval available with explicit degraded semantic coverage.

Actual live acceptance is separate: Plaid Sandbox was exercised, and Google Photos OAuth/session creation has been authorized. Full live provider/model checks, production bank feasibility, and deployment acceptance remain tracked in OpenSpec. Local Ollama embeddings/classification/vision passed live synthetic checks; owner-selected Photos are processing. No production deployment is claimed.

Setup and recovery: [authentication](docs/authentication.md), [Photos](docs/photos.md), [local models](docs/local-models.md), [classification](docs/classification.md), [retrieval](docs/retrieval.md), [MCP](docs/mcp.md), [operations](docs/operations.md), [backup/restore](docs/backup-restore.md), [deployment](docs/deployment.md).

## Local PostgreSQL

Docker must be running. Copy `.env.example` to `.env` if it does not exist. The Compose credentials are development-only and the port is bound to loopback.

```sh
npm run db:up
npm run db:check
npm run dev:api
```

`db:up` waits for PostgreSQL readiness. `db:check` verifies pgvector is installed. Use `npm run db:stop` to stop the service while preserving its named volume. The first startup enables pgvector via `infra/postgres/init.sql`. Existing volumes are not reinitialized. Invalid configuration is rejected before API/worker startup; configuration errors do not print connection strings.

## Processing configuration

Defaults are a 20 MiB media limit, 30-day historical backfill, and 90-day future calendar coverage. Set `MAX_MEDIA_BYTES`, `BACKFILL_DAYS`, and `CALENDAR_FUTURE_DAYS` to override them. These limits describe intended coverage, not completed imports.

Models are disabled until configured. Each of `EMBEDDING`, `CLASSIFIER`, and `VISION` needs `_ENDPOINT`, `_MODEL`, and `_VERSION`; `_API_KEY` is optional for a local gateway. Embeddings additionally require explicit `_DIMENSIONS` (1–2000 for the initial indexed vector representation). Remote endpoints require HTTPS. No production model is selected implicitly.

The provider-neutral gateway adapter POSTs `{model, version, input}`. Embeddings accept `input.texts` and return `{embeddings: number[][]}`; classification accepts `input.text` and returns `{labels, reason, confidence}` plus optional exact `personal_evidence`; task extraction accepts `input.task_text` and returns evidence-backed requests/resolutions; vision accepts `input.image: {mimeType, base64}` and returns `{description, ocr}`. Labels exclude `unorganized`, which the pipeline assigns on failure. Confidence is null or 0–1. A concrete provider must implement this gateway contract or the shared adapter interfaces; vendor API URLs are not automatically compatible. Errors retain HTTP status without copying response bodies or credentials.

Database schema, migration, freshness, and queue recovery details are in [docs/database.md](docs/database.md). Run `npm run db:migrate` after database startup. Use `npm run test:db:isolated` for tests on a fresh temporary database.

## Slack and Calendar progress

Slack setup and worker commands are in [docs/slack.md](docs/slack.md). After configuring an owner-authorized installation and encrypted app token, run `npm run worker:slack` for receipt and `npm run worker:slack-process` for event processing and 15-minute reconciliation. Neither command invents a workspace connection. Calendar page/cursor behavior is documented in [docs/calendar.md](docs/calendar.md); its scheduled wiring is integrated into the default worker.

Capital One live verification is blocked on production provider access; see [docs/capital-one.md](docs/capital-one.md).

The default worker initializes enabled Gmail, Slack, Calendar, and Capital One streams and schedules each due stream every fifteen minutes. Two ingestion lanes share durable leases; separate photo and classification/indexing lanes prevent local model work from consuming ingestion capacity. Slack Socket Mode receipt runs separately with `npm run worker:slack`; its inbox is processed by the default worker. The older Slack-only processor is an alternative, not a requirement. Photos remains user-initiated.
