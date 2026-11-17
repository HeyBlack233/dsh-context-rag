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
├── memories/
│   ├── global/          # all-workspace memories (Markdown + MEMORY.md)
│   └── workspaces/
│       └── <workspace-slug>/   # per-workspace memories (Markdown + MEMORY.md)
├── index.sqlite         # rebuildable index (pair and memory vectors)
├── recall-state.json    # turn-dedupe bookkeeping (disposable)
└── logs/                # manual log exports (only after Write to disk)
```

## Backup

The **JSONL pair log is the source of truth**; it is what you want to preserve.
To back up all captured data, copy the `pairs/` directory:

```sh
cp -r "$DSH_HOME/context-rag/pairs" /path/to/backup/
```

Backing up `pairs/` is sufficient for full pair recovery: the index is
rebuildable from it. You may also back up `config.json` if you want to restore
configuration (note that API keys would be included).

**Memories** are plain files too: copy `memories/` to preserve them (Markdown
files plus their `MEMORY.md` indexes). Their vectors are rebuilt from the
files on the next startup scan, so they are covered by the same rule — the
index is a rebuildable cache.

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
the existing vectors invalid (see below). Memory vectors are cleared too and
are re-created from the memory files on the next startup scan.

## Memory sync on startup

There is **no real-time file watcher** for memories. On startup the plugin
scans `memories/` and:

- rewrites each `MEMORY.md` index to match its directory (adds missing
  entries, removes entries whose file is gone or `.forgotten`);
- re-queues changed or new memory files for embedding;
- deletes SQLite vectors for memory files that no longer exist or were
  forgotten.

Manual edits to memory files (creating, editing, or deleting `<name>.md`) are
therefore picked up on the next plugin startup or activation, not immediately.

## Embedding model/dimension changes require a reindex

The index stores the embedding `model` and `dim` for each vector, and retrieval
only compares vectors with the same model/dim as the query. If you change the
embedding model or `dimensions`:

1. Existing vectors are no longer comparable to new queries.
2. **Clear the index** (`index.clear`) or **rebuild** it so pairs are re-embedded
   with the new model/dimensions.

Deleting `index.sqlite` (or clearing via the page) and letting the worker
re-embed resolves the mismatch.

## Index consistency check and repair

The Browse tab on the configuration page (see
[configuration-page.md](configuration-page.md#browse)) inspects and repairs the
index on demand.

- **When to run**: open the Browse tab, pick a scope, and click **Check
  index**. Run it whenever the status strip shows pending or error counts,
  after an embedding model/dimension change, after `index.clear` /
  `index.rebuild`, after manually editing the JSONL or memory files, or any
  time you want to verify that the index matches the sources. There is
  **no automatic or periodic audit** — a check only runs when you click.
- **What the states mean**: each entry reports one of `consistent`, `missing`,
  `stale-text`, `pending`, `model-mismatch`, `corrupt`, `orphan`, or `unknown`
  (fail-open), with the precedence documented in
  [storage-and-data-model.md](storage-and-data-model.md#index-consistency-states).
  Orphans (index rows with no source) are **reported only**: Browse never
  removes them, and the next indexer reconcile pass (startup, or after
  `config.save`) deletes orphan rows automatically.
- **Per-entry re-index**: select a non-consistent, non-orphan entry and click
  **Re-index**. The entry's source is re-read fresh and embedded
  **synchronously** through the configured embedding endpoint (one request,
  using the same text building/truncation as the background worker). On
  success the row's model/dim/indexed-at are updated and the status refreshes.
  Re-index is **disabled while no embedding model is configured** (and while
  embedding is disabled). On failure the entry **stays queued in the outbox**
  with backoff for the background worker to retry: the page reports
  `EMBEDDING_FAILED` with `{queued: true}` and keeps the outbox rows (reason,
  attempts, last error) visible in the detail.
- **Text-change CAS**: the new vector is stored under a compare-and-swap guard
  on the source text hash. If the source text changes while the embedding
  request is in flight, the stale vector is **not** written (`TEXT_CHANGED`,
  409) and the outbox entry is left in place, so the background worker (or a
  fresh re-index) indexes the newer text.
- **Forget memory from Browse**: the **Forget** button (two-click
  confirmation) has the same semantics as `memory_forget`: `<name>.md` is
  renamed to `<name>.forgotten` (history preserved on disk), the `MEMORY.md`
  index is rebuilt, the SQLite index row and its outbox entry are deleted, and
  the memory's recall-state entries are cleared. If a `.forgotten` file
  already exists the request fails with `FORGOTTEN_CONFLICT` rather than
  overwriting history; nothing is hard-deleted.

## Outbox retry behavior and error inspection

Pairs awaiting embedding sit in the SQLite `outbox`. The background worker
drains it in batches and retries failures with backoff:

- Each pair has an `attempts` counter and a `next_attempt_at` timestamp
  controlling when it may be retried.
- Failures delay the next attempt by `retryDelayMs`.
- After `maxAttempts`, a pair is **dropped from the outbox** (it is not
  embedded).

To inspect errors, open the **Logs** tab on the configuration page first (or
export the current window to a file — see
[Logs and diagnostics](#logs-and-diagnostics)): embedding/rerank failures log a
warning with the pair and the underlying error. A pair dropped from the outbox
remains in the JSONL log, so it can be re-queued later by a reconcile or rebuild
if desired.

## Logs and diagnostics

The plugin's own logger (wrapping `ctx.logger`) is teed into an **in-memory
ring buffer** that keeps only the latest `logging.bufferSize` entries (default
`200`, integer `1..5000`). Each entry carries a UTC ISO timestamp, a level
(`debug` / `info` / `warn` / `error`), and a message. Debug-level entries are
collected and forwarded only while `logging.debug` is enabled.

- **Memory-only by default**: nothing is written to disk automatically. The
  window is lost on plugin restart, and entries overwritten by newer ones are
  unrecoverable.
- **Viewing**: the **Logs** tab on the configuration page shows the window
  (oldest to newest, scrollable) and auto-refreshes every 2 seconds while the
  tab is active (see [configuration-page.md](configuration-page.md)).
- **Exporting**: the **Write to disk** button runs the `logs.export` action and
  writes the **current window** to a new file,
  `<home>/logs/context-rag-YYYYMMDD-HHmmss-SSS.log`, using the host's local
  time; on a name collision the file gets a `-1`/`-2` suffix. The file is plain
  text with a header recording the export time, the configured limit, and the
  number of entries written, and is created with mode `0600`. Each click
  produces a new file; nothing is exported automatically.
- **No growth or rolling**: exported files are not part of any log rotation and
  are never cleaned up or overwritten by the plugin.
- **Deleting is safe**: files under `logs/` are disposable — removing them only
  deletes exported diagnostics, never plugin data.

## Disk usage

Disk usage comes almost entirely from:

- The JSONL pair log (`pairs/`) — grows with every captured turn.
- The SQLite index (`index.sqlite`) — proportional to the number of indexed
  pairs and their embedding size.
- The recall state (`recall-state.json`) — small (ids/turns/timestamps/counts
  only) and bounded by retention: sessions older than
  `dedupeStateRetentionDays` and sessions beyond `dedupeStateMaxSessions` are
  pruned on load and after every write.
- Exported log files (`logs/`) — **only when you export**: the in-memory log
  window itself never touches disk, and each export writes exactly one new file.

The index is bounded and rebuildable; the JSONL is the durable and growing
record. If disk is a concern, prune the JSONL (see safe deletion below) and then
rebuild/clear the index.

## Safe deletion

- **JSONL**: deleting or editing lines in `pairs/` removes that data
  permanently. The index still holds the old embeddings until a reconcile or
  rebuild drops them, so follow up with a rebuild/clear after editing the log.
- **Memory files (`memories/`)**: the Markdown files are the source of truth
  for memory content. Deleting a `<name>.md` removes that memory; its vector is
  dropped on the next startup scan. `.forgotten` files are retained history
  and are ignored by recall and the `MEMORY.md` index.
- **`MEMORY.md`**: regenerated by the plugin on every memory write and on the
  startup scan; deleting one is harmless (it is rewritten from the directory).
- **`index.sqlite`**: safe to delete at any time; it is rebuilt from JSONL and
  the memory files.
- **`recall-state.json`**: safe to delete at any time; only dedupe history is
  lost (pairs and memories become eligible again). It is recreated as needed.
- **`config.json`**: removing it resets configuration (including any stored API
  keys).
- **`logs/`**: exported log files only; deleting them is safe and does not
  affect the pair log, memories, or the index.

## Common failure modes

| Symptom | Likely cause | Resolution |
| --- | --- | --- |
| Short turn not stored or recalled | User message below `retrieval.minMessageLength` (default `8`) | Expected default behavior; set `retrieval.minMessageLength = 0` to disable the gate or use a longer message. |
| No context injected | Not configured — no embedding endpoint set | Configure `baseUrl`/`model` and confirm `enabled`/`injectionEnabled`. |
| Embedding request rejected | `401`/`403` from the embedding endpoint | Check the API key and endpoint authorization. |
| Embedding request slow/fails | Timeout on the endpoint | Increase `embedding.timeoutMs`; check connectivity. |
| Vectors not comparable | Dimension mismatch between query and index | Match `dimensions`/model; reindex after a model change. |
| Rerank fails | Rerank endpoint down or misconfigured | Fix rerank config; the pipeline **falls back** to non-reranked results. |
| Index not writable | SQLite unavailable / `initError` at startup | Check the data home is writable; verify SQLite can open/create `index.sqlite`. |
| Turn dedupe not applied / history not recorded | `recall-state.json` missing, corrupt, or unwritable | Recall state is **fail-open**: a warning is logged, dedupe is skipped, and injection continues. A memory write still succeeds; it is just not recorded for dedupe (and is skipped outright for subagent sessions or hosts without a turn projection). Check the data home is writable; deleting the file resets dedupe history. |
| Memory change not recalled | Manual Markdown edit made after startup | There is no real-time watcher; restart/activate the plugin so the startup scan synchronizes `MEMORY.md` and the vectors. |

All failure modes are **fail-open** on the read path: retrieval errors skip
injection and log a warning rather than failing the turn (see
[retrieval-and-injection.md](retrieval-and-injection.md)). The write path keeps
pairs in the outbox and retries within `maxAttempts`.

## Upgrade notes

- To upgrade, **reinstall the bundle** (for example, install the newer
  `@local/dsh-context-rag` version over the previous one).
- **No data migration is expected**: the JSONL pair log, the memory files, and
  the index format are stable, so an upgrade does not rewrite or move your
  data. The startup scan refreshes `MEMORY.md` indexes and memory vectors.
- **New defaults apply to existing configs**: nothing is deleted or migrated,
  and existing `config.json` files simply gain the new defaults
  (`retrieval.minMessageLength = 8`, `retrieval.allowSameSession = false`,
  `retrieval.dedupeTurns = 5`, `retrieval.dedupeStateRetentionDays = 90`,
  `retrieval.dedupeStateMaxSessions = 500`). Note that short user messages now
  skip capture and passive recall by default; set
  `retrieval.minMessageLength = 0` to disable that gate, and set
  `retrieval.allowSameSession = true` to restore same-session recall.
- **Logging defaults are filled in automatically**: existing configs gain
  `logging.bufferSize = 200` and `logging.debug = false` with no migration.
  In-memory logs are not persisted, so the window simply starts empty after an
  upgrade; no `logs/` directory is created until you export.
- After upgrading, restart/activate the plugin so the worker and hooks are
  re-registered; startup reconciliation ensures the index is current.
- **DSH release compatibility**: the bundle declares
  `engines.dsh: ^0.2.1-rc.2`, mirroring it on the `@deepseek-ai/dsh-tools`
  peer. A DSH release outside that range makes DSH skip the bundle at profile
  startup or disable its row, with a compatibility message — the plugin does
  not corrupt data and simply stays inactive. Upgrade to a release inside the
  range, or widen the range as a reviewed change (see
  [compatibility.md](compatibility.md)); do not rely on a per-profile
  exemption as a permanent fix.
