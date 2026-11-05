# Operations

This page covers day-to-day operation of `context-rag`: where data lives, how
to back up and maintain the index, how failures surface, and what to do when
you upgrade. For the on-disk layout see
[storage-and-data-model.md](storage-and-data-model.md).

## Data home

All plugin data lives under a single home directory, `$DSH_HOME/context-rag/`
by default (overridable through the `home` field):

```
$DSH_HOME/context-rag/
├── config.json          # runtime config (atomic, mode 0600)
├── pairs/
│   └── <workspace-slug>/
│       └── <session-slug>.jsonl
├── index.sqlite         # rebuildable index
└── recall-state.json    # turn-dedupe bookkeeping (disposable)
```

## Backup

The **JSONL pair log is the source of truth**; it is what you want to preserve.
To back up all captured data, copy the `pairs/` directory:

```sh
cp -r "$DSH_HOME/context-rag/pairs" /path/to/backup/
```

Backing up `pairs/` is sufficient for full data recovery: the index is
rebuildable from it. You may also back up `config.json` if you want to restore
configuration (note that API keys would be included).

`recall-state.json` is **optional** to back up: it holds turn-dedupe history
only (see [storage-and-data-model.md](storage-and-data-model.md)) and is not
needed for pair recovery. Skipping it means pairs may be re-injected once after
a restore — dedupe history simply resets.

## Rebuild the index

`index.sqlite` is a rebuildable cache. To rebuild it from the JSONL log:

- From the configuration page, use the `index.rebuild` action. It runs
  asynchronously; the page polls the index status until it reports completion.
- Or delete `index.sqlite` and restart the harness — startup reconciliation
  re-queues missing or changed pairs and re-embeds them.

## Clear the index

The configuration page's `index.clear` action clears the index (and outbox)
but **keeps the JSONL log**. This is useful when you want to start retrieval
from scratch without losing history. Use it when an embedding-model change makes
the existing vectors invalid (see below).

## Embedding model/dimension changes require a reindex

The index stores the embedding `model` and `dim` for each vector, and retrieval
only compares vectors with the same model/dim as the query. If you change the
embedding model or `dimensions`:

1. Existing vectors are no longer comparable to new queries.
2. **Clear the index** (`index.clear`) or **rebuild** it so pairs are re-embedded
   with the new model/dimensions.

Deleting `index.sqlite` (or clearing via the page) and letting the worker
re-embed resolves the mismatch.

## Outbox retry behavior and error inspection

Pairs awaiting embedding sit in the SQLite `outbox`. The background worker
drains it in batches and retries failures with backoff:

- Each pair has an `attempts` counter and a `next_attempt_at` timestamp
  controlling when it may be retried.
- Failures delay the next attempt by `retryDelayMs`.
- After `maxAttempts`, a pair is **dropped from the outbox** (it is not
  embedded).

To inspect errors, look at the harness logs: embedding/rerank failures log a
warning with the pair and the underlying error. A pair dropped from the outbox
remains in the JSONL log, so it can be re-queued later by a reconcile or rebuild
if desired.

## Disk usage

Disk usage comes almost entirely from:

- The JSONL pair log (`pairs/`) — grows with every captured turn.
- The SQLite index (`index.sqlite`) — proportional to the number of indexed
  pairs and their embedding size.
- The recall state (`recall-state.json`) — small (ids/turns/timestamps/counts
  only) and bounded by retention: sessions older than
  `dedupeStateRetentionDays` and sessions beyond `dedupeStateMaxSessions` are
  pruned on load and after every write.

The index is bounded and rebuildable; the JSONL is the durable and growing
record. If disk is a concern, prune the JSONL (see safe deletion below) and then
rebuild/clear the index.

## Safe deletion

- **JSONL**: deleting or editing lines in `pairs/` removes that data
  permanently. The index still holds the old embeddings until a reconcile or
  rebuild drops them, so follow up with a rebuild/clear after editing the log.
- **`index.sqlite`**: safe to delete at any time; it is rebuilt from JSONL.
- **`recall-state.json`**: safe to delete at any time; only dedupe history is
  lost (pairs become eligible again). It is recreated as needed.
- **`config.json`**: removing it resets configuration (including any stored API
  keys).

## Common failure modes

| Symptom | Likely cause | Resolution |
| --- | --- | --- |
| No context injected | Not configured — no embedding endpoint set | Configure `baseUrl`/`model` and confirm `enabled`/`injectionEnabled`. |
| Embedding request rejected | `401`/`403` from the embedding endpoint | Check the API key and endpoint authorization. |
| Embedding request slow/fails | Timeout on the endpoint | Increase `embedding.timeoutMs`; check connectivity. |
| Vectors not comparable | Dimension mismatch between query and index | Match `dimensions`/model; reindex after a model change. |
| Rerank fails | Rerank endpoint down or misconfigured | Fix rerank config; the pipeline **falls back** to non-reranked results. |
| Index not writable | SQLite unavailable / `initError` at startup | Check the data home is writable; verify SQLite can open/create `index.sqlite`. |
| Turn dedupe not applied / history not recorded | `recall-state.json` missing, corrupt, or unwritable | Recall state is **fail-open**: a warning is logged, dedupe is skipped, and injection continues. Check the data home is writable; deleting the file resets dedupe history. |

All failure modes are **fail-open** on the read path: retrieval errors skip
injection and log a warning rather than failing the turn (see
[retrieval-and-injection.md](retrieval-and-injection.md)). The write path keeps
pairs in the outbox and retries within `maxAttempts`.

## Upgrade notes

- To upgrade, **reinstall the bundle** (for example, install the newer
  `@local/dsh-context-rag` version over the previous one).
- **No data migration is expected**: the JSONL pair log and the index format are
  stable, so an upgrade does not rewrite or move your data.
- **New defaults apply to existing configs**: nothing is deleted or migrated,
  and existing `config.json` files simply gain the new defaults
  (`retrieval.allowSameSession = false`, `retrieval.dedupeTurns = 5`,
  `retrieval.dedupeStateRetentionDays = 90`,
  `retrieval.dedupeStateMaxSessions = 500`). The most visible behavior change
  is that same-session recall is now **off by default**; set
  `retrieval.allowSameSession = true` to restore it.
- After upgrading, restart/activate the plugin so the worker and hooks are
  re-registered; startup reconciliation ensures the index is current.
