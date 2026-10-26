# Local execution and deployment

Local commands (Node 24, npm, Docker):

```sh
npm ci
npm run db:up
npm run db:migrate
npm run owner:setup
```

Run these in separate terminals:

```sh
npm run dev:api
npm run dev:web
npm run dev:worker
```

Open http://127.0.0.1:5173. Vite proxies API/auth/MCP requests to API_PORT from the root environment. The current local API port is 3001 because another app uses 3000. Create owner-scoped connections and Photos selections from the dashboard; create separately scoped agent credentials for MCP. Configure models using local-models.md. For Slack, configure the app/token/subscriptions and separately run `npm run worker:slack` for Socket Mode receipt. The main worker processes its durable inbox and 15-minute reconciliation. Do not run the older Slack-only processor as an additional requirement.

Production needs a PostgreSQL server with pgvector, persistent storage, migrations run by an administrative setup identity, credential encryption key in an external secret store, and appropriate memberships for the restricted reader/audit roles. Configure database and model/provider environment values on the server. Keep worker access independent from public HTTP routing. Do not expose PostgreSQL or the local model service publicly.

Build the dashboard with `npm run build`. Serve apps/web/dist through a TLS reverse proxy/static server. Proxy `/api/*`, `/auth/*`, `/health`, and `/mcp` to the Hono API; serve other dashboard paths from the static build. Vite development proxy settings do not apply to production static hosting. Use the same public origin for dashboard/authentication, set APP_ORIGIN exactly, and register that origin's provider OAuth callbacks. Owner cookies require HTTPS outside loopback. MCP clients call the public HTTPS `/mcp` URL with a private bearer header. The API and workers run as separate supervised processes using their workspace start commands; Socket Mode also needs a supervised receiver. Apply migrations before starting a new release.

No hosting provider, production hostname/TLS, or production bank connection has been configured by this implementation. Local Ollama models are configured and have passed live synthetic checks. No production deployment is claimed. Provider checks and model pinning remain explicit configuration/acceptance gates. Preserve incomplete live tasks in OpenSpec until actual authorized checks succeed.

Verification commands:

```sh
npm run typecheck
npm test
npm run test:db:isolated
npx playwright install chromium
npm run test:ui
npm run build
npx openspec validate personal-context-mvp --strict
```

Database tests use unique temporary databases. Browser tests mock API/provider responses and start a separate Vite instance on port 5174. The MCP test uses an actual SDK client/transport against Hono and PostgreSQL fixtures. The backup/restore drill uses fixture-only temporary databases, as documented in backup-restore.md. These checks establish implementation behavior without substituting for real provider/model authorization.
