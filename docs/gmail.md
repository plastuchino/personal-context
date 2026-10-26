# Gmail connector

The Gmail adapter reads messages with the `gmail.readonly` scope. Connection OAuth also requests OpenID/email for account identity; sent messages are included so reply relationships can be interpreted. Mailbox access is authorized by the owner. No send, modify, or delete permission is requested.

`gmailPage` accepts an authorized provider GET transport, account ID, persisted cursor, and backfill days. Initial retrieval captures the mailbox history anchor before reading paginated IDs in the configured date range, then reads full messages. It preserves thread identity, source links, source timestamps, Message-ID/In-Reply-To headers, participants, owner identity, labels, and original message payloads. Attachments remain represented in provider payload metadata; binary attachment analysis is not part of this message-body adapter.

History retrieval handles message additions and label changes by refetching the current message, and handles deletion events with tombstones. A missing message during retrieval is treated as deleted. Expired history returns an explicit reset so the runner can record it and restart a bounded backfill rather than silently advancing a bad cursor. Pagination preserves the original history anchor until its last page. History IDs are not timestamps and are never represented as source freshness times.

Canonical ingestion persists normalized messages, participants, and email details transactionally. Replaying the same message uses its existing record and revision. The worker orchestration and scheduled connector wiring are tracked separately from this page adapter. The backfill range and any history reset must be exposed as coverage information; this adapter does not claim retrieval of the entire mailbox.

Reference: [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync).
