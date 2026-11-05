# Storage and Data Model

This page describes how `context-rag` stores pairs, memories, and index data
on disk.

## Data home

All plugin data lives under a single home directory, `$DSH_HOME/context-rag/`
by default. It can be overridden through the plugin row `home` field.

```
$DSH_HOME/context-rag/
├── config.json          # runtime config (atomic, mode 0600)
├── pairs/
│   └── <workspace-slug>/
│       └── <session-slug>.jsonl
├── memories/
│   ├── global/
│   │   ├── MEMORY.md
│   │   └── <name>.md
│   └── workspaces/
│       └── <workspace-slug>/
│           ├── MEMORY.md
│           └── <name>.md
├── index.sqlite         # rebuildable index (pair and memory vectors)
└── recall-state.json    # turn-dedupe bookkeeping (separate, disposable)
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

## Memory files (memories/)

Memories are persistent Markdown notes managed through the `memory_*` tools
(`memory_list`, `memory_get`, `memory_write`, `memory_forget`; see
[retrieval-and-injection.md](retrieval-and-injection.md)). They live under two
fixed locations:

- `memories/global/` — memories available from every workspace.
- `memories/workspaces/<workspace-slug>/` — memories scoped to that workspace
  (the slug matches the pair log's workspace slug).

Each memory is a `<name>.md` file with a YAML front matter block and a body.
The front matter is written line by line between `---` fences — one `key:
value` per line, with string values quoted in JSON style — so any characters
in the field values are handled safely:

```md
---
name: "alpha"
description: "one-line summary"
type: "global"
createdAt: 1730000000000
cwd: ""
---
<content, stored verbatim>
```

For backward compatibility, older files whose front matter is a single-line
JSON flow mapping (`---` / `{...}` / `---`) are still read correctly.

- `name` must match `[A-Za-z0-9_-]+` and cannot be `MEMORY` (case-insensitive,
  reserved for the index file). `description` is a non-empty, single-line
  summary. `type` is the directory kind, `"global"` or `"workspace"` (must
  match the directory). `createdAt` is the epoch-millisecond creation time, and
  `cwd` holds the original workspace directory (empty for `global`).
- `name` and `description` are expected to be written in English, while
  `content` may be in the user's language.
- `content` is stored verbatim and capped at
  `embedding.maxEmbeddingChars` characters — the same limit applied before
  embedding — so a memory always fits one embedding request. Content that
  exceeds the cap is rejected, not truncated.
- Each directory carries a `MEMORY.md` index listing every active memory as
  `- <name> - <description>` (one entry per line, sorted by name). The plugin
  regenerates it on writes and on the startup scan, and `memory_write` reserves
  the name `MEMORY`, so a memory file can never collide with the index.
- Forgetting renames the file to `<name>.forgotten` (history is preserved on
  disk), removes the entry from `MEMORY.md`, and deletes the memory's vector
  from SQLite. A new memory with the same name can be created afterwards; the
  old `.forgotten` file stays untouched and is ignored by recall.
- The memory files are the source of truth for memory content; manual edits are
  picked up by the startup scan (there is no real-time file watcher — see
  [operations.md](operations.md)).

## SQLite index (index.sqlite)

`index.sqlite` is a rebuildable cache over the pair log and the memory files.
It is safe to delete; startup reconciliation re-queues missing or changed
pairs and memories and re-embeds them.

### `pairs`

Stores pair and memory metadata with their embeddings.

| Column (typical) | Meaning |
| --- | --- |
| `pair_id` | Primary key; matches `pairId` in JSONL (pairs) or `memory:<type>:<scope>:<name>` (memories). |
| `session_id` | Session id (for scoping/debugging); empty for memories. |
| `cwd` | Workspace directory used for scope filtering; empty for global memories. |
| `turn` | Turn number. |
| `created_at` | Capture time. |
| `user_text` | Pair user message, or the memory `content` for memory rows. |
| `assistant_text` | Pair assistant reply; empty for memories. |
| `text_hash` | Hash of the indexed text, used to detect changes. |
| `record_type` | `"pair"` or `"memory"` — which kind of record the row indexes. |
| `memory_type` | For memory rows: `"global"` or `"workspace"`; `NULL` for pairs. |
| `name` | Memory name (memories only). |
| `description` | Memory description (memories only). |
| `embedding` | Normalized embedding as a BLOB. |
| `model` | Embedding model id the vector was produced by. |
| `dim` | Embedding dimensionality. |

The `model` + `dim` pair guarantees the query and candidates are comparable
(see [retrieval-and-injection.md](retrieval-and-injection.md)). Pre-memory
databases are migrated non-destructively: the new columns are added and
existing rows default to `record_type = 'pair'` (`schema_version = 2`).

### Memory vectors

Memory vectors live in the same SQLite index and are queued through the same
`outbox` as pair vectors, so pairs and memories share one embedding pipeline,
one `model`/`dim` compatibility check, and the same retry/backoff behavior.
The Markdown files remain the source of truth for memory content; the index
only caches their embeddings. The startup scan deletes vectors for memory
files that no longer exist or were forgotten.

### `outbox`

A queue of records (pairs and memories) awaiting embedding.

| Column (typical) | Meaning |
| --- | --- |
| `pair_id` | Record to embed. |
| `reason` | Why it is queued (e.g. `new`, `text-changed`). |
| `attempts` | Number of embedding attempts so far. |
| `next_at` | When the worker may retry (backoff). |
| `last_error` | Error message of the last failed attempt. |

### `meta`

Key/value store for index bookkeeping (e.g. schema version, worker state).

## Recall state (recall-state.json)

`recall-state.json` holds the turn-dedupe bookkeeping for context injection
(see [retrieval-and-injection.md](retrieval-and-injection.md)). It is a
separate file from `index.sqlite` and is written atomically with mode `0600`.
It stores **only ids, turns, timestamps, and counts — never message text**.

Schema (JSON, version 1):

```json
{
  "version": 1,
  "sessions": {
    "<sessionId>": {
      "lastActiveAt": 1730000000000,
      "entries": {
        "<pairId>": { "lastTurn": 12, "lastRecallAt": 1730000000000, "count": 2 }
      }
    }
  }
}
```

- Per (session id, pair id), `lastTurn` is the turn the pair was last injected,
  `lastRecallAt` when that happened, and `count` how many times it has been
  injected. `lastActiveAt` is the session's most recent recall activity.
- **Retention**: cleanup runs on load and after every write. Sessions whose
  latest recall is older than `retrieval.dedupeStateRetentionDays` (default
  `90`) are dropped, and at most `retrieval.dedupeStateMaxSessions` (default
  `500`) most-recently-active sessions are kept. `0` disables the corresponding
  limit; with both `0`, pruning never removes data by age or count.
- **Persistence**: the file survives plugin/DSH restarts and deletion of
  `index.sqlite` — the two stores are independent.
- **Safe to delete**: deleting `recall-state.json` merely resets dedupe history
  (pairs become eligible again); nothing else is affected. It is **not** part
  of the JSONL source of truth.
- **Fail-open**: if the file is missing, corrupt, or unwritable, the store
  warns and continues with empty state, so retrieval/injection keeps working
  without turn dedupe.

## Write path

1. **Capture** — a turn-stopping hook stores a (direct user message, final
   assistant reply) pair. Only source-kind `user` messages are captured as the
   user side; subagent sessions, interrupted turns, and empty turns are skipped.
2. **Append** — the pair is appended to the JSONL log first.
3. **Enqueue** — the pair is then enqueued to the `outbox`.

The JSONL write is the commit point; the index follows asynchronously.

Memory writes follow the same commit-point rule: `memory_write` writes (or
overwrites) the `<name>.md` file and refreshes the `MEMORY.md` index, then
enqueues the memory's embedding through the same `outbox`. `memory_forget`
renames the file to `<name>.forgotten`, removes the `MEMORY.md` entry, and
deletes the SQLite vector, while keeping the file on disk for history.

## Indexing worker

- A single background worker drains the `outbox`, batching records (pairs and
  memories) by `batchSize` and computing embeddings in one request where
  possible.
- Each vector is normalized before being written to `pairs`.
- Failures retry with backoff up to `maxAttempts`; the next attempt is delayed
  by `retryDelayMs`. The worker polls the outbox every `pollIntervalMs`.

## Startup reconcile

On startup, the plugin reconciles JSONL against the index. Pairs present in
JSONL but missing from the index, or whose `textHash` differs from the current
entry (content changed, so the embedding is stale), are re-queued. This makes
the index self-healing and keeps JSONL as the durable record.

The same startup pass scans the memory store: `MEMORY.md` files are rewritten
to match their directories (missing entries added, entries for deleted or
`.forgotten` files removed), changed or new memory files are re-queued, and
SQLite vectors for memory files that no longer exist (or were forgotten) are
deleted. There is no real-time file watcher, so manual Markdown edits are
picked up on the next startup.
