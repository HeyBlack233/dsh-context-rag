# Configuration

`context-rag` is configured through the panel on the plugin's page in the
Harness GUI (`client.js`). The runtime config is persisted to `config.json`
under the data home (atomic write, mode `0600`). API keys are redacted and
**never returned to the browser**.

Defaults are exact and grouped below. Endpoint URLs and models are empty by
default, so the plugin starts in a passive state until an embedding endpoint is
configured.

## Embedding

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for embedding/retrieval. |
| `baseUrl` | `""` | Base URL of the embedding API. |
| `model` | `""` | Embedding model id. |
| `dimensions` | `null` | Expected vector dimensionality; used to validate candidates. |
| `timeoutMs` | `3000` | Embedding request timeout. |
| `maxRetries` | `2` | Embedding retry count before the worker gives up. |
| `batchSize` | `16` | Pairs embedded per worker batch. |
| `maxEmbeddingChars` | `8000` | Text truncated to this length before embedding. |

## Rerank

Optional; disabled by default.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` | Whether to rerank retrieved candidates. |
| `baseUrl` | `""` | Base URL of the rerank API. |
| `path` | `"/rerank"` | Endpoint path appended to `baseUrl`. |
| `model` | `""` | Rerank model id. |
| `timeoutMs` | `5000` | Rerank request timeout. |
| `maxRetries` | `1` | Rerank retry count. |

## Retrieval

| Field | Default | Meaning |
| --- | --- | --- |
| `scope` | `"workspace"` | Candidate scope: `"workspace"` (exact `cwd`) or `"all"`. |
| `candidateLimit` | `20` | Max candidates scanned from the index. |
| `topK` | `5` | Number of pairs injected into context. |
| `minScore` | `0.4` | Minimum cosine similarity to be considered. |
| `maxContextChars` | `3000` | Cap on injected context text length. |
| `timeoutMs` | `3000` | Retrieval pipeline timeout. |
| `injectionEnabled` | `true` | Whether to inject retrieved context at all. |
| `scanLimit` | `5000` | Max index rows examined during the scan. |

## Indexing

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for the background indexing worker. |
| `retryDelayMs` | `2000` | Backoff delay between embedding retry attempts. |
| `maxAttempts` | `8` | Max attempts before a pair is dropped from the outbox. |
| `pollIntervalMs` | `1000` | Worker polling interval for the outbox. |

## Home directory

| Field | Default | Meaning |
| --- | --- | --- |
| `home` | `$DSH_HOME/context-rag/` | Root directory for `config.json`, `pairs/`, and `index.sqlite`. |

## Editing and safety

- Editing the config in the GUI writes `config.json` atomically and mode `0600`.
- **API keys are never returned to the browser.** The config page can set them,
  but reads back redacted values.
- The SQLite index is rebuildable: deleting `index.sqlite` is safe and it is
  rebuilt from the JSONL pair log on the next startup reconcile.

## Minimal setup to activate retrieval

1. Set the embedding `baseUrl` and `model` (and `dimensions` if known).
2. Keep `enabled` and `injectionEnabled` true.
3. Optionally enable `rerank.enabled` and point it at an OpenAI-compatible
   rerank endpoint.

Until an embedding endpoint is configured, capture still appends to JSONL, but
no embeddings are produced and no context is injected.
