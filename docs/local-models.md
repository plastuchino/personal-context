# Local model service

The application supports a native Ollama adapter in addition to the existing HTTP gateway. It uses local `/api/embed` for vectors and schema-constrained `/api/chat` for classification and image descriptions/OCR. Source text is untrusted input. All responses pass the same label, confidence, and embedding-dimension validation as gateway responses.

Install and run Ollama locally, then choose and pull models that support embeddings, structured chat, and vision respectively. A vision-capable model can serve both classification and images. The owner selected setup on this Mac; the local configuration uses the models named above. Other deployments choose their own installed models. Ollama is now installed on this Mac as a Homebrew service with cloud features disabled. The configured models are embeddinggemma:latest (768-dimensional embeddings) and gemma3:4b (classification and vision). Their exact installed digests are pinned privately in .env. Live setup checks passed for embeddings, routine-newsletter classification, two distinct quoted requests, and a synthetic receipt description/OCR.

For each configured stage use these settings (substitute EMBEDDING, CLASSIFIER, or VISION):

```dotenv
CLASSIFIER_ADAPTER=ollama
CLASSIFIER_ENDPOINT=http://127.0.0.1:11434
CLASSIFIER_MODEL=your-installed-model:tag
CLASSIFIER_VERSION=sha256:the-full-64-character-model-digest
```

Find the installed name and digest using `curl http://127.0.0.1:11434/api/tags`. Pin the full digest returned by that service, not `latest` or an arbitrary version label. Before sending content, the adapter checks that the installed model still matches. Changing a tag to different weights fails visibly until configuration is deliberately updated. Ollama endpoints must be loopback origins; this adapter does not target Ollama's cloud. Keep the Ollama deployment configured for local execution.

Embeddings additionally require `EMBEDDING_DIMENSIONS` matching the selected model (at most 2000 for the PostgreSQL index). Oversized model input fails instead of silently truncating. Set all endpoint/model/version values together; incomplete configuration prevents startup. Leave an entire stage unset to keep it visibly unconfigured. Gateway deployments retain the default `*_ADAPTER=gateway` and existing request contract.

After setting models, restart the worker. Configure model versions before generating real derived content. Configured classification/indexing worker stages now process the durable queue. Keyword indexing remains usable without an embedding model; missing model work is observable and retryable. Vision processing is connected to the Photos worker.

API references: [embeddings](https://docs.ollama.com/api/embed), [structured output](https://docs.ollama.com/capabilities/structured-outputs), [chat and image input](https://docs.ollama.com/api/chat).

## Reproduce the configured setup

```sh
brew install ollama
brew services start ollama
ollama pull embeddinggemma
ollama pull gemma3:4b
npm run models:setup
```

Keep `disable_ollama_cloud: true` in `~/.ollama/server.json` to preserve local-only execution. The current service has this setting, verified in its startup log. The service binds to loopback. Use `brew services stop ollama` / `brew services start ollama` to manage it.

`models:setup` discovers installed digests and embedding dimensions, performs live synthetic embedding/classification/task/receipt-OCR checks, and only then writes model settings to the private .env. It does not print provider credentials or source contents. `LOCAL_EMBEDDING_MODEL` and `LOCAL_VISION_MODEL` can select different installed model names for that command; names require explicit tags. Restart API/worker after changing their environment. Model weights use Ollama's local model directory, not PostgreSQL; source data, media, derived content, chunks, and vectors remain in PostgreSQL.

The local task-output schema permits only supplied existing task IDs and requires an empty resolution list when none exist. This prevents invented task references while preserving server-side exact-quote validation. An initial live test rejected invented resolutions; the tightened schema passed before the production queue was enabled.

References for the configured choices: [Gemma 3 4B vision model](https://ollama.com/library/gemma3:4b), [EmbeddingGemma](https://ollama.com/library/embeddinggemma), [Ollama local-only configuration](https://docs.ollama.com/faq).

Vision requests default to 180 seconds because a selected JPEG with extensive text needed about 65 seconds in a live check. Embedding/classifier requests default to 60 seconds. `VISION_TIMEOUT_MS`, `CLASSIFIER_TIMEOUT_MS`, and `EMBEDDING_TIMEOUT_MS` can override these bounds (up to 600000 ms). Lease heartbeats continue during inference. The local Ollama service is configured for two concurrent requests so vision does not monopolize model processing.
