# Read-only MCP client setup

Create an agent in the owner dashboard, selecting explicit source accounts, and copy its credential once into your client's private configuration. The endpoint is `http://127.0.0.1:3001/mcp` for the current local API port; use your configured API_PORT. Deployed access requires HTTPS. Configure a Streamable HTTP MCP client with:

```json
{
  "url": "http://127.0.0.1:3001/mcp",
  "headers": {"Authorization": "Bearer YOUR_PRIVATE_AGENT_CREDENTIAL"}
}
```

The JSON is a connection fragment; your client's enclosing configuration syntax varies. Keep credentials in private settings or a secret store. The service uses stateless JSON responses and authenticates every HTTP request. It does not implement OAuth discovery for MCP; a client must support custom bearer headers. Dashboard cookies do not authenticate MCP and agent credentials do not authenticate dashboard controls.

Tools:

- `search_context`: query, exact filters, limit, cursor. For example `{ "query": "refund decision", "limit": 10 }` or `{ "filters": { "amount": "12.34", "currency": "USD" } }`.
- `get_record`: record_id, optional text_offset/text_limit, for current source text and provenance.
- `get_revision`: record_id/revision_id and optional chunk_id, or the exact `personal-context://...` URI returned by search. It checks the complete record/revision/chunk relationship and supports historical evidence.
- `list_blocking_tasks`: status (open/done/uncertain), limit. Task evidence contains source quotes, immutable provenance, and freshness.
- `get_source_status`: only granted accounts, stream coverage/check/watermark times, and Slack connection state.

All returned source content is marked untrusted data. It cannot change grants, trigger source actions, issue SQL, or complete a task. Every content excerpt includes its provenance, source provider/environment (including Sandbox), and explicit selected-media scope for Photos; generated image descriptions are explicitly interpretations with model/version metadata. See retrieval.md for filters, pagination bounds, model fallback, and coverage semantics.

There are no mutation tools, including mark_task_done, label updates, synchronization, outbound messages, or provider actions. An attempted unsupported tool cannot change persisted data. Revoke credentials in the dashboard to reject subsequent requests. Direct IDs, historical citations, evidence, counts, and candidate ranking use the same source-grant boundary. Missing and ungranted records produce identical errors.

Audits retain only client ID, fixed tool/decision, time, and returned record IDs. They never store tool arguments, search text, source content, or bearer credentials. The reader role cannot mutate records/tasks or read encrypted credentials. A separate append-only audit role is the only retrieval-side database writer. Requests are limited to 16 KiB; tool results are bounded and responses above 4 MiB fail with a request to narrow the query. Clients should use smaller limits and body offsets for long records.

`npm run test:db:isolated` exercises an actual TypeScript SDK client and Streamable HTTP transport against the API with temporary PostgreSQL fixture data: tool discovery, search, source/task citations, exact revision resolution, source edits/deletion, cross-account denial, unknown task-completion attempts, audit redaction, and revocation. Provider/model responses remain fixtures; no live model inference or production financial access is implied.
