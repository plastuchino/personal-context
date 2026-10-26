# Slack ingestion

Slack uses the authorized user's read/history scopes for public/private channels, direct messages, and group messages. Workspace policies, membership, retention, and app installation approval limit available data. The user token does not bypass these limits. OAuth connection setup is documented in `authentication.md`.

The Web API adapter enumerates conversations with pagination and retrieves bounded history and thread pages. Cursors, channel IDs, and message timestamps remain lossless strings. A page can report its interval complete only when pagination is finished and Slack has not reported limited history; the orchestration must combine every page before declaring a whole stream complete. A configured backfill shorter than seven days cannot establish complete seven-day participation coverage. Inaccessible conversations fail explicitly. A provider `has_more` response without a usable cursor fails instead of silently claiming completion.

Replies preserve their parent timestamp even when the parent is outside the recent history range. Reconciliation must separately revisit tracked thread roots. Message bodies and original payloads are retained, with participants and typed Slack identifiers persisted atomically. Provider permalinks are retained when supplied; otherwise the internal record URI is the citation fallback. Edits and deletions require the Socket Mode event path plus scheduled reconciliation; recent-message history polling alone is insufficient.

References: [conversation listing](https://docs.slack.dev/reference/methods/conversations.list/), [history](https://docs.slack.dev/reference/methods/conversations.history/), [thread replies](https://docs.slack.dev/reference/methods/conversations.replies/).

## Durable event receipt

Set `SLACK_APP_ID` to the registered Slack app ID; it cannot be inferred from the OAuth client ID. OAuth records the app/workspace/authorized-user installation mapping. Existing Slack connections require reauthorization to establish this mapping. Incoming message events must match that exact installation, including a user authorization, before source data is stored. A shared workspace alone never authorizes routing.

The event inbox and its per-channel processing job commit together before the envelope is acknowledged. Redelivery is deduplicated by account/event ID. Database failures leave the delivery unacknowledged. Unsupported or unauthorized payloads are ignored without logging their content. Worker crashes leave durable inbox work available for recovery.

## Socket Mode setup

In your Slack app settings, enable Socket Mode and create an app-level `xapp-` token with `connections:write`. Subscribe under **Events on behalf of users** to `message.channels`, `message.groups`, `message.im`, and `message.mpim`; the OAuth user scopes still govern accessible history. Set `SLACK_APP_ID`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and the credential encryption key before authorizing.

After owner login, send `POST /api/connections/slack/:accountId/socket-token` with `{app_token}` and the normal owner session/Origin/CSRF headers. The server encrypts the token separately from the OAuth user credential and returns only readiness. Agents cannot configure it. Replacing the token triggers worker connection reload.

Run `npm run worker:slack` from the repository root. The worker groups authorized installations by app and holds a database advisory lock for one socket per app across worker processes. Every delivered payload is checked against its authorized installation before receipt. No public webhook URL or send-message scope is required. The SDK handles socket protocol/refresh notifications; the controller reconnects with exponential delays capped at 60 seconds, stopping after twelve consecutive failures. Missing/rejected tokens and connection gaps remain observable; restart or reconfigure after exhausted retries. SDK logs are suppressed so token values, temporary socket URLs, and message bodies cannot enter operational logs. Only fixed error codes are persisted.

A successful connection does not clear an outage gap. Event receipt time and processing time are separate; a quiet channel does not imply a broken socket. Scheduled reconciliation and worker processing are required in addition to the receiver. Live workspace validation remains a separate acceptance task.

## Processing and reconciliation

Run `npm run worker:slack-process` alongside the Socket Mode receiver. This processor discovers active Slack installations, schedules discovery/channel reconciliation every fifteen minutes, and claims only Slack ingestion/event jobs. Other pipeline stages remain separately tracked. It renews leases during long calls, records fixed error codes, and honors provider retry delays. Rotating user tokens are refreshed under an account lock using the Slack OAuth client credentials.

Event work and history pages use the same channel stream lock. Source versions use exact numeric Slack timestamps; delayed creations/edits cannot overwrite newer content or restore a tombstoned message. Delete-before-create events preserve deletion evidence. Changed records queue classification/embedding work and participation/task-context refresh; historical revisions remain available for citations.

A reconciliation cycle freezes its time bounds, paginates history, then revisits every tracked thread root, including roots older than the recent-message range. Checkpoints resume interrupted cycles. Completed interval coverage and retention limits are stored separately from connection health. Lost access or an empty response is never treated as proof of deletion.

Outage gaps remain visible after reconnection and successful sweeps because Slack may no longer expose missed historical changes or deleted messages. Recovered replies and current snapshots advance reconciliation progress without claiming recovery of unavailable history. `last_event_received_at`, `last_event_processed_at`, and `last_reconciled_at` describe separate stages. Live workspace event/recovery checks are still required before release acceptance.

## Local OAuth redirect

The current Slack authorization-code flow requires an HTTPS redirect. For this project's local dashboard, run `npm run slack:https:setup`, then run `npm run dev:slack-callback` alongside the API. The helper creates a local development certificate/key under ignored `.local/slack-oauth/`, writes SLACK_REDIRECT_URI to the private environment, and changes no system certificate trust settings. Restart the API after changing its environment.

Register this exact value under Slack **OAuth & Permissions → Redirect URLs**, then save:

```text
https://127.0.0.1:5443/api/connections/slack/callback
```

Open https://127.0.0.1:5443 once before connecting. Your browser will ask you to accept this locally generated development certificate for that loopback address. Return to http://127.0.0.1:5173 and use Connect Slack. The bridge forwards only the Slack GET callback to the loopback API, preserves the owner cookie, and returns successful authorization to the configured dashboard origin. The callback still validates the existing single-use OAuth state and owner session. It does not provide a public events webhook; Socket Mode setup is separate.

Google callbacks continue to use the dashboard origin. A deployed HTTPS dashboard can use its normal `/api/connections/slack/callback` route without the local bridge. A custom Slack callback must use HTTPS on the same hostname as the dashboard so the owner session remains bound correctly.

Checks cover callback forwarding restrictions, cookie forwarding, unsafe redirect rejection, and HTTPS redirect consistency between Slack authorization and token exchange. A local TLS request verifies the listener, and an unauthenticated callback receives 401. Live Slack authorization remains pending owner app configuration.
