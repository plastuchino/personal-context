# Selected Google Photos imports

Sign in to the dashboard and click **Connect Google Photos**, complete Google consent, then click **Choose photos** beside the connected account. The Picker opens in a new tab. If your browser blocks it, use the fallback link beside **Choose photos**. Select items and confirm the selection in Google. Return to the dashboard to watch import progress. Start `npm run dev:worker` to process the selection. Connect the owner account through Google Photos OAuth as described in `authentication.md`. The Picker API scope is required. Owner-authenticated `POST /api/photos/:sourceAccountId/sessions` (session, Origin, and CSRF headers) creates a Picker session and returns its selection URL, internal ID, and expiry. Open that URL as a top-level page; it cannot be embedded in an iframe. `GET /api/photos/sessions/:id` reports operational import status.

A durable job follows the provider's recommended polling interval. It lists media only after the owner completes selection. A polling timeout or expired session produces an explicit expired status requiring a new selection. Photos is excluded from scheduled whole-library synchronization: each session imports only the photos/videos the owner picked.

Picked media IDs persist across sessions. Records retain original metadata and creation time, with an internal record URI as the stable source citation when no provider permalink exists. Expiring base URLs are never used as permanent citations. Media download and analysis are separate stages, so successful selection does not imply bytes or search indexes are already ready.

References: [Picker sessions](https://developers.google.com/photos/picker/reference/rest/v1/sessions), [picked media](https://developers.google.com/photos/picker/reference/rest/v1/mediaItems).

## Media download

Selected files are streamed with a configured byte limit, including when Content-Length is missing. Downloads only send OAuth credentials to approved Google media hosts and reject redirects to other hosts. Expired base URLs are renewed from the same selected session when possible; expired sessions require new selection.

PostgreSQL stores bytes with SHA-256 content hashes and declared-size checks. Repeated imports of unchanged media reuse the same record revision and byte artifact; a changed content hash creates a new revision. Original metadata and source timestamps remain separate from generated interpretations. Videos use metadata-only analysis in v1.

## Analysis and worker execution

The default `npm run dev:worker` now processes Picker polling, selected-item discovery, bounded downloads, and image analysis jobs. Set `VISION_ENDPOINT`, `VISION_MODEL`, and `VISION_VERSION` (plus its API key when required) using the provider-neutral gateway contract in the README. OCR and descriptions are stored as separate versioned derived artifacts; they do not replace original metadata. Descriptions are model interpretations. Their text queues fresh classification and embedding jobs, which the configured classification/indexing workers process separately.

Import status counts distinguish selection, downloaded artifacts, completed analysis, failures, keyword indexing, classification, and configured-model embeddings. Missing/unavailable models produce visible retryable job errors and eventually a failed import rather than fabricated captions. When vision is configured later, the scheduler resumes prior photo_model_unconfigured analysis failures as the original distinct jobs, preserving normal stream leases, deduplication, and bounded retry cycles. Stored bytes can be analyzed after Picker expiry. Expired selection sessions require a new selection. Videos finish with metadata-only coverage and do not download video bytes, even when an expired selection would prevent a media download. Progress reports metadata_only separately.

The pipeline is covered by provider fixtures and PostgreSQL integration tests. Live Google OAuth, Picker session creation/selection, and selected-media downloads have now been observed locally. The configured local models passed a synthetic receipt OCR check, and the owner-selected media batch is processing. A single-photo import session has now completed with zero failures, and selected photo description evidence has resolved through the running MCP endpoint with exact model/version and chunk provenance, satisfying the authorized smoke check. The larger batch continues; this does not imply every selected item has completed. See verification.md for the observed scope and remaining failures.
