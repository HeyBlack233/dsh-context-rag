# Architecture

`context-rag` is a DeepSeek Harness (DSH) plugin that adds retrieval-augmented
generation to sessions. After each completed turn it stores the (user message,
final assistant reply) pair as human-readable JSONL, indexes an embedding in
SQLite, and before each model step retrieves similar past pairs — plus
persistent **memories** managed through the `memory_*` tools — and injects the
top results as a durable, read-only context message.

This page gives an end-to-end overview. See
[storage-and-data-model.md](storage-and-data-model.md) for how data is laid out,
[retrieval-and-injection.md](retrieval-and-injection.md) for the read path, and
[configuration.md](configuration.md) for every tunable.

## Two data flows

The plugin has two independent, asynchronous flows over the same store.

1. **Write path (indexing).** A turn-stopping hook captures the direct user
   message and the final assistant reply, appends them to a JSONL log (the
   source of truth), then enqueues an embedding job. The `memory_write` tool
   follows the same pattern: it writes the Markdown memory file and refreshes
   the `MEMORY.md` index (the file write is the commit point), then enqueues an
   embedding job. A single background worker batches jobs, computes normalized
   vectors via an embedding API, and writes them into the SQLite index.
2. **Read path (retrieval).** An `agent/pre-step` hook detects new direct user
   messages, embeds the query, scans the SQLite index for similar past pairs
   **and memories** (excluding same-session pairs by default and turn-deduped
   candidates in injection mode), optionally reranks, and injects the top
   results into the conversation as a read-only context message.

Both flows are fail-open: timeouts or errors skip injection and log a warning
rather than disrupting the turn.

## Module map

| Module | Responsibility |
| --- | --- |
| `index.js` | Plugin lifecycle: config loading, service wiring, hook registration, worker start/stop, memory store setup, and the startup memory scan. |
| `lib/config.js` | Load, validate, and persist runtime config; redact API keys. |
| `lib/paths.js` | Resolve the data home and all file paths underneath it. |
| `lib/text.js` | Text normalization and character-truncation helpers. |
| `lib/pairs.js` | Read and append the JSONL pair log; compute text hashes. |
| `lib/db.js` | SQLite connection, schema creation, atomic writes; indexes memory vectors alongside pair vectors (shared outbox). |
| `lib/capture.js` | Turn-stopping capture: decide what to store and enqueue outbox rows. |
| `lib/indexer.js` | Background worker: drain the shared outbox (pairs and memories), batch embeddings, write index, retry. |
| `lib/embeddings.js` | Call the configured embedding API; produce normalized vectors. |
| `lib/rerank.js` | Optional call to an OpenAI-compatible rerank endpoint. |
| `lib/memories.js` | Memory store: read/write/forget Markdown memories, maintain `MEMORY.md` indexes, `.forgotten` handling, and the startup sync scan. |
| `lib/memory-tools.js` | The `memory_list` / `memory_get` / `memory_write` / `memory_forget` agent tools. |
| `lib/retrieval.js` | Query embedding, candidate scan over pairs and memories (global + current workspace), scoring, top-K selection, and turn dedupe. |
| `lib/render.js` | Build the injected context text from retrieved pairs and memories. |
| `lib/message.js` | Construct and manage context messages and their source metadata. |
| `lib/inject.js` | Dedupe per user message, attach the injected context message, and record the actually rendered candidates for turn dedupe. |
| `lib/recall-state.js` | Persistent turn-dedupe state: per-(session, pair) last turn, timestamp, and count; retention pruning; atomic persistence. |
| `lib/api.js` | Plugin-internal API surface (services exposed to the host). |
| `client.js` | Web config page presented in the Harness GUI. |

## Lifecycle

`index.js` boots on plugin activation:

1. Read the plugin row config and resolve the data home
   (`$DSH_HOME/context-rag/` by default).
2. Open the SQLite index and ensure the schema exists.
3. Load the persistent recall state (`recall-state.json`) and prune it with the
   configured retention limits. This is fail-open: if it cannot be created or
   loaded, the plugin continues without it and turn dedupe simply does not run.
4. Reconcile JSONL vs index (re-queue pairs that are missing or whose text hash
   changed).
5. Scan the memory store: synchronize manual Markdown edits (rewrite
   `MEMORY.md` indexes, add or re-queue changed memories, drop vectors for
   deleted or `.forgotten` files). There is no real-time file watcher; this
   scan runs on startup only.
6. Start the single background indexing worker.
7. Register the write-path and read-path hooks.
8. Expose the config panel (`client.js`) and the internal API (`lib/api.js`).

On shutdown, the worker is drained and the SQLite connection is closed. Recall
state is written on every change, so no shutdown flush is needed.

## Key properties

- **Append-only source of truth.** The JSONL pair log is the durable record;
  the SQLite index is a rebuildable cache. Deleting `index.sqlite` is safe — it
  is rebuilt from JSONL on the next startup reconcile.
- **Memories are files.** Memory content lives in plain Markdown under
  `memories/`; the SQLite index only caches their embeddings, and `MEMORY.md`
  indexes are regenerated from the files. Memories are recalled as read-only,
  **untrusted** reference material, exactly like retrieved pairs.
- **State/index separation.** Turn-dedupe bookkeeping lives in its own
  `recall-state.json`, independent of `index.sqlite`: it survives index
  deletion and is safe to delete itself (only dedupe history resets).
- **Single writer.** Embedding computation and index writes go through one
  worker, keeping batching and ordering simple.
- **Fail-open read path.** Retrieval errors never block the turn; recall-state
  failures degrade to no turn dedupe, never to a failed step.
- **No external dependencies at runtime.** Embeddings come from a configurable
  HTTP endpoint; there is no external vector database. The reranker is optional.

## Scope for this cycle

- No SVG icon is shipped in this cycle (per user request).
- No external vector database; candidates are scanned in the local SQLite index.
- The reranker is optional and disabled by default.
- Memory files have no real-time watcher; manual edits are synchronized by the
  startup scan (see [operations.md](operations.md)).
