# Authentication setup

Run migrations before setup. Run `npm run owner:setup` in an interactive terminal and enter your password twice at the hidden prompts. For noninteractive setup, supply `OWNER_PASSWORD` privately for that command only, then unset it. Passwords require 12–1024 characters and are stored as salted scrypt hashes. Resetting the password invalidates existing sessions. Do not place real passwords in documentation, committed files, or command history.

Set `APP_ORIGIN` to the exact dashboard origin (default `http://127.0.0.1:5173`). HTTPS is required outside loopback. Login requires this Origin. Owner cookies are HttpOnly and SameSite=Lax (to allow top-level OAuth callbacks); HTTPS uses a Secure `__Host-` cookie. Sessions expire after 12 hours. A successful login or session check returns a CSRF token; mutations require the session cookie, matching Origin, and `X-CSRF-Token`. Session checking rotates the token, so use the latest response. Ten login attempts per fifteen minutes are permitted across this single-owner service.

Generate a base64 32-byte `CREDENTIAL_ENCRYPTION_KEY` outside the database and retain it securely with your backup recovery material. AES-256-GCM authenticates encrypted provider credentials. Do not log the key or tokens. Losing the key requires provider reauthorization. Credentials are stored through encrypted credential references; model API keys remain deployment environment configuration.

OAuth states are random, stored only as digests, bound to owner session/provider, expire after ten minutes, and are consumed once. Provider routes must validate state before token exchange. HTTP API errors return generic descriptions without raw exceptions, source bodies, provider tokens, or connection strings.

Start `npm run dev:api` and `npm run dev:web`, then open `http://127.0.0.1:5173`. Sign in with your owner password. The dashboard provides source connection and reauthorization buttons, and Google Photos selection/import progress. Browser OAuth success returns to the dashboard. Agent grant/revocation, personal-conversation settings, and operational metrics are available. Read-only MCP setup is described in mcp.md.

## Agent credentials

Owner-authenticated `POST /api/agents` accepts `{name, accounts: [sourceAccountId]}` with CSRF protection and returns a one-time bearer credential. Only its SHA-256 digest is persisted. `DELETE /api/agents/:id` revokes it. At least one explicit source grant is required; there is no all-sources default.

`personal_context_reader` is a NOLOGIN role with SELECT privileges and row-level source filtering; it cannot modify personal data or access encrypted credentials. The retrieval transaction sets the verified agent ID before querying. `personal_context_audit` has only audit INSERT permission. Runtime service users must be granted membership in their required roles by deployment setup; the local database administrator can exercise both for tests. Do not issue database credentials to agents or permit arbitrary SQL. Source grants and revocation are checked at request time. MCP tool routes enforce this role boundary; see mcp.md.

## Provider OAuth

Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` for a Google web application, and `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` for a Slack application. Set the credential encryption key before connecting. Never send those secrets to the browser. Register exact callback URLs at `${APP_ORIGIN}/api/connections/{provider}/callback` for `gmail`, `calendar`, `google-photos`, and `slack`. During local development Vite proxies `/api` and `/auth` to Hono.

Owner-authenticated `POST /api/connections/:provider/start` (CSRF required) returns the authorization URL. The callback validates the owner session and single-use state, exchanges the code on the server, verifies required granted scopes and account identity, and stores encrypted credentials. Missing settings return 503. Denial or exchange failure returns a recoverable generic error and permits restarting setup. Reauthorization follows the same flow, reusing the provider/account identity and existing grants.

Enable Gmail, Calendar, and Photos Picker APIs in your Google project and configure its consent screen/test-user access. Google also requests OpenID and email to verify connection identity. Requested source scopes are Gmail read-only, Calendar read-only, or Photos Picker read-only according to the chosen connection; Google read access does not provide whole-library Photos synchronization. Slack requests user read/history scopes for channels, groups, direct messages, group direct messages, and users. Workspace approval and accessible history limit actual coverage. Financial-provider authorization is a separate connector prerequisite.

Provider references: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Google Photos authorization](https://developers.google.com/photos/overview/authorization), [Slack OAuth](https://docs.slack.dev/authentication/installing-with-oauth/).

## Local browser checks

Run `npx playwright install chromium` once, then `npm run test:ui`. This starts a separate loopback Vite instance on port 5174 and mocks provider/API responses. It verifies login, credential clearing, escaped source names, selected-photo progress, retry controls, agent grants/revocation, and personal settings. It does not perform Google consent or source ingestion. The separate PostgreSQL checks (`npm run test:db:isolated`) verify authentication, CSRF, encrypted credential redaction, persisted settings, queue deduplication, and grant storage against a temporary database.

Vite reads `API_PORT` from the root `.env` for its server-side proxy. Keep it consistent with Hono. If another application uses port 3000, choose a free port (the current local configuration uses 3001). Restart API and Vite after changing it. No provider credentials are injected into the browser configuration.
