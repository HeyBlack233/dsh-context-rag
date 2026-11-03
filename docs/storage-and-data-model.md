# Storage and Data Model

This page describes how `context-rag` stores pairs and index data on disk.

## Data home

All plugin data lives under a single home directory, `$DSH_HOME/context-rag/`
by default. It can be overridden through the plugin row `home` field.

```
$DSH_HOME/context-rag/
├── config.json          # runtime config (atomic, mode 0600)
├── pairs/
│   └── <workspace-slug>/
│       └── <session-slug>.jsonl
└── index.sqlite         # rebuildable index
```

## config.json

Runtime config is stored here. It is written atomically, created with mode
`0600`, and API keys are never returned to the browser (see
[configuration.md](configuration.md)).

## Pair log (JSONL)

`pairs/<workspace-slug>/<session-slug>.jsonl` is the append-only source of
truth. One JSON object per line. The slug reflects the workspace and session
the pair belongs to, so pairs from different workspaces/sessions stay in
separate files.

Each line is an object with these fields:

| Field | Meaning |
| --- | --- |
| `pairId` | Stable identifier for the pair (unique per entry). |
| `sessionId` | Session that produced the pair. |
| `cwd` | Workspace working directory at capture time. |
| `turn` | Turn/step number within the session. |
| `createdAt` | ISO timestamp of the pair. |
| `user` | The direct user message text. |
| `assistant` | The final assistant reply text. |

The log is human-readable and can be inspected, grepped, or edited directly.

## SQLite index (index.sqlite)

`index.sqlite` is a rebuildable cache over the pair log. It is safe to delete;
startup reconciliation re-queues missing or changed pairs and re-embeds them.

### `pairs`

Stores pair metadata and its embedding.

| Column (typical) | Meaning |
| --- | --- |
| `pair_id` | Primary key; matches `pairId` in JSONL. |
| `session_id` | Session id (for scoping/debugging). |
| `cwd` | Workspace directory used for scope filtering. |
| `turn` | Turn number. |
| `created_at` | Capture time. |
| `text_hash` | Hash of the combined pair text, used to detect changes. |
| `embedding` | Normalized embedding as a BLOB. |
| `model` | Embedding model id the vector was produced by. |
| `dim` | Embedding dimensionality. |

The `model` + `dim` pair guarantees the query and candidates are comparable
(see [retrieval-and-injection.md](retrieval-and-injection.md)).

### `outbox`

A queue of pairs awaiting embedding.

| Column (typical) | Meaning |
| --- | --- |
| `pair_id` | Pair to embed. |
| `payload` | The JSONL entry to embed. |
| `attempts` | Number of embedding attempts so far. |
| `next_attempt_at` | When the worker may retry (backoff). |

### `meta`

Key/value store for index bookkeeping (e.g. schema version, worker state).

## Write path

1. **Capture** — a turn-stopping hook stores a (direct user message, final
   assistant reply) pair. Only source-kind `user` messages are captured as the
   user side; subagent sessions, interrupted turns, and empty turns are skipped.
2. **Append** — the pair is appended to the JSONL log first.
3. **Enqueue** — the pair is then enqueued to the `outbox`.

The JSONL write is the commit point; the index follows asynchronously.

## Indexing worker

- A single background worker drains the `outbox`, batching pairs
  (`batchSize`) and computing embeddings in one request where possible.
- Each vector is normalized before being written to `pairs`.
- Failures retry with backoff up to `maxAttempts`; the next attempt is delayed
  by `retryDelayMs`. The worker polls the outbox every `pollIntervalMs`.

## Startup reconcile

On startup, the plugin reconciles JSONL against the index. Pairs present in
JSONL but missing from the index, or whose `textHash` differs from the current
entry (content changed, so the embedding is stale), are re-queued. This makes
the index self-healing and keeps JSONL as the durable record.
