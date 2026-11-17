# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and
this project adheres to [Semantic Versioning](https://semver.org/). GitHub
Release titles use the format `dsh-context-rag v{version}`.

## [0.0.0] - Unreleased

Release Date: TBD

### Highlights

- Placeholder — filled in at release time.

### Details

- Store each qualifying turn's (user message, final assistant reply) pair in a
  human-readable JSONL store, indexed with embeddings in SQLite.
- Embedding indexer with an outbox: pairs are queued for embedding and the
  SQLite index can be rebuilt from the JSONL store.
- Workspace-scoped or all-workspace retrieval of similar past pairs, with
  optional rerank via a Jina / Cohere / SiliconFlow-compatible `/v1/rerank`
  endpoint.
- Pre-step durable context injection: retrieved pairs are injected as a
  read-only context message shown in the Trajectory. The injected text is an
  HTML-like tagged structure (`<context-rag>`, `<notice>`, `<turn>`,
  `<memory>`, `<user>`, `<assistant>`) with metadata in
  attributes, entity-escaped content, and a fixed notice that the retrieved
  turns are reference material rather than a source of truth, replacing the
  previous plain `[n] … User:/Assistant:` layout.
- Short-message gate: `retrieval.minMessageLength` (default `8`, `0` disables)
  skips passive recall (pairs and memories) and capture for user messages
  below the threshold, so such turns never enter the JSONL log, SQLite index,
  or outbox. Han characters count one each, Latin/digit runs count one word,
  and punctuation/whitespace/emoji are ignored; the comparison is strict.
- Cosine and rerank score thresholds are separate settings: `minScore` filters
  cosine similarity before reranking, and `rerankMinScore` filters the rerank
  relevance score. Both range from `0.00` to `1.00` with two decimals.
- Configure panel on the plugin's page in the DSH Web GUI, above the
  **Components** section (no separate row page): separate cards for the
  embedding, rerank, retrieval, and indexing settings, an advanced JSON view,
  write-only API-key handling, and English/Simplified Chinese UI.
- Config panel reorganized into **Dashboard** and **Configuration** tabs: a
  persistent status strip keeps index counts and indexer state visible, the
  Dashboard groups health information with index rebuild/clear, the
  Configuration tab keeps the four settings cards plus a collapsible advanced
  JSON view and save/reload/test actions, and the active tab is remembered
  across refreshes. Switching tabs preserves unsaved edits.
- The config panel now fills the plugin detail column instead of capping at
  840 px with page padding, so its cards and tabs line up with the
  **Components**, **Versions**, and **Source** sections.
- Same-session recall is now **off by default**: `retrieval.allowSameSession`
  (default `false`) excludes pairs from the current session in all recall modes;
  set it to `true` to allow them. Forked/derived sessions count as different
  sessions.
- Injection-only turn dedupe: `retrieval.dedupeTurns` (default `5`) keeps a
  pair or memory from being recalled again until `T - L >= dedupeTurns`; `0`
  disables turn dedupe and `-1` allows each candidate at most once per session,
  ever. Only candidates actually rendered into the injected context are
  recorded, plus memories written by `memory_write` (see below).
- Persistent recall state in a separate `recall-state.json` (ids, turns,
  timestamps, and counts only — never message text), pruned by
  `retrieval.dedupeStateRetentionDays` (default `90`) and
  `retrieval.dedupeStateMaxSessions` (default `500`); `0` disables the
  corresponding limit. It survives plugin/DSH restarts and `index.sqlite`
  deletion, and is safe to delete (dedupe history resets).
- Retrieval `stats` now report `candidateCount`, `excludedSameSession`,
  `excludedDedupe`, and `dedupeApplied`; the API status carries the three
  exclusion counters. None of this is written into the injected context text.
- Existing `config.json` files gain the new defaults automatically; nothing is
  deleted or migrated.
- **Memory tools** (`memory_list`, `memory_get`, `memory_write`,
  `memory_forget`): persistent Markdown notes under `memories/global/` and
  `memories/workspaces/<workspace-slug>/`, each with YAML front matter
  (`name`, `description`, `type`) and a `MEMORY.md` index. The tools operate
  only on `global` or the current workspace.
- **Memory recall**: memories from the global store and the current workspace
  are retrieved together with conversation pairs through the same
  embedding/outbox, cosine scoring, `scanLimit`, `candidateLimit`/`topN`,
  rerank, `topK`, and `maxContextChars` pipeline. `retrieval.scope` does not
  affect memory recall; same-session exclusion applies to conversation pairs
  only, while turn dedupe applies to both.
- **Memory write rules**: `memory_write` overwrites an existing same-name
  memory, requires `name` to match `[A-Za-z0-9_-]+` (reserving `MEMORY`), and
  caps `content` at `embedding.maxEmbeddingChars`. Names and descriptions are
  expected in English; content may be in the user's language. The tool lists
  the index before writing to avoid semantic duplicates and updates the same
  name for the same topic.
- **Memory writes count toward turn dedupe**: a successful `memory_write`
  (`created` or `updated`) records the memory's `pairId` at the current turn,
  so a just-written memory is not recalled again in the writing session until
  `retrieval.dedupeTurns` has passed — exactly like an injection. Subagent
  sessions and hosts without a current-turn projection skip the record
  (fail-open; the write still succeeds). `memory_forget` clears the memory's
  entries from every session's recall history.
- **Memory forgetting**: `memory_forget` runs only on explicit user request,
  matches `name` + `description` exactly, renames the file to
  `<name>.forgotten`, and removes it from the `MEMORY.md` index and SQLite
  while keeping the file on disk for history. A new memory with the same name
  can be created later; the old `.forgotten` file is preserved.
- **Startup memory scan**: manual Markdown edits are synchronized on startup —
  `MEMORY.md` indexes are rewritten and SQLite vectors for missing or
  `.forgotten` files are removed. There is no real-time file watcher.
- Memories are treated like retrieved pairs: read-only, **untrusted** reference
  material with the same fixed warning.
- Agent tool definitions: the `memory_list` / `memory_get` / `memory_write` /
  `memory_forget` descriptions now state each rule once and leave input rules
  (charset, reserved `MEMORY`, length, exact-match requirement) on the
  parameters; the repeated cwd caveat moved to the shared `type` parameter and
  the internal turn-dedupe detail and write-trigger guidance were removed,
  shrinking the model-visible tool schemas with unchanged runtime behavior.
- Tests, documentation, and a CI workflow covering the plugin.
- **DSH compatibility range**: `engines.dsh` and the `@deepseek-ai/dsh-tools`
  peer now declare `^0.2.1-rc.2` (`>=0.2.1-rc.2 <0.3.0-0`) instead of pinning a
  single release, so every current `0.2.x` DSH (including prereleases) is
  accepted while `0.3.0` prereleases and later still require a review. The
  tested `dsh-tools` dev dependency stays exact. See
  [docs/compatibility.md](docs/compatibility.md).
- **Clean disposal on older hosts**: the capture listeners now unregister
  through the disposers returned by `ctx.on` and probe `ctx.off` defensively.
  Cordis contexts without an `off` method throw on the property read (observed
  on dsh `0.2.1-rc.2` during plugin disposal).
- **Logs tab** on the configuration page: shows the plugin's own log entries —
  UTC ISO time, level (`debug` / `info` / `warn` / `error`), and message —
  oldest to newest in a scrollable list, auto-refreshing every 2 seconds while
  the tab is active and stopping when you leave it. The tab offers an **N**
  input with **Apply**, an **Enable debug** checkbox, **Refresh**, and
  **Write to disk**.
- **In-memory log window**: the plugin's logger is teed into a bounded in-memory
  ring buffer that keeps only the latest `logging.bufferSize` entries (default
  `200`, integer `1..5000`). Logs are **never written to disk automatically** —
  they are lost on plugin restart, and overwritten entries are unrecoverable.
- **Logging settings**: `logging.bufferSize` and `logging.debug` (default
  `false`) are persisted to `config.json` and take effect immediately from the
  Logs tab (resizing trims the buffer right away; disabling debug stops
  debug-level capture and forwarding). Existing configs gain the defaults
  automatically with no migration.
- **Manual log export**: **Write to disk** writes the current window to a new
  file `<home>/logs/context-rag-YYYYMMDD-HHmmss-SSS.log` (host-local time,
  `-1`/`-2` suffix on collision, plain text with an export header, mode `0600`)
  and shows the path on the page. Each click produces a new file; exports do
  not participate in log rolling or cleanup. Log entries never contain message
  or memory bodies, query text, or API keys.
- **Browse tab** on the configuration page (second tab, after **Dashboard**):
  browse stored memories and message pairs per scope (`All` / `Global` /
  workspaces; `Global` is memories-only) in a fixed-height split list/detail
  view (`68 vh`) where the list and the detail body scroll independently, so
  selecting an entry never changes the card height; on narrow screens
  (≤ 720 px) the split stacks vertically at `82 vh` with internal scrolling.
  Lists load lazily on tab entry — no polling — one page of 20 at a time with
  a **Load more** button.
  Pair rows preview the user message (200 characters,
  whitespace-normalized); the detail shows the full text capped at 200,000
  characters per field with a truncation note, plus metadata, index status,
  and outbox state for pending entries. Everything is read-only except the
  two explicit actions below.
- **Index consistency statuses**: every Browse entry carries a status pill —
  `consistent`, `missing`, `stale-text`, `pending`, `model-mismatch`,
  `corrupt`, `orphan` (audit only), and `unknown` (fail-open) — computed from
  the source-of-truth rule (JSONL + memory files are authoritative; SQLite
  stores the indexed copy). Precedence: `missing` → `stale-text` → `pending` →
  `corrupt` → `model-mismatch` → `consistent`; the model/dim comparison is
  skipped when no embedding model is configured.
- **Check index (audit)**: the Browse **Check index** action audits the
  current scope on demand — status counts, mismatched entries (capped at 500
  with a truncation notice), orphan rows, and malformed JSONL line counts —
  with an **Only mismatched** filter. There is no automatic or periodic audit;
  orphans are reported only and cleaned by the next indexer reconcile pass.
- **Per-entry re-index**: non-consistent entries offer a **Re-index** action
  that synchronously re-embeds the single entry through the configured
  embedding endpoint (disabled when no embedding model is configured). On
  failure the entry stays queued in the outbox for the background retry, and a
  text-hash compare-and-swap prevents a stale vector from overwriting newer
  text.
- **Forget from Browse**: memories can be forgotten in the Browse tab with a
  two-click confirmation, with the same semantics as `memory_forget` — the
  file is renamed to `<name>.forgotten` (history preserved on disk), the
  `MEMORY.md` index is rebuilt, and the index row and recall-state entries are
  removed.
- **Browse manual search**: a search form above the Browse toolbar finds
  matching persistent memories and message pairs by meaning in one scope,
  regardless of the Memories/Pairs mode toggle. It runs **only on demand**
  (Search button or Enter; an empty query does nothing) and there is still no
  polling. Results are mixed and capped at 20, in final-score-descending
  order, each row showing a kind badge, a score pill (`Score 0.xxx ·
  cosine|rerank`), and the index-status pill. Scope semantics: `All` searches
  all pairs and all memories (all workspaces); `Global` searches global
  memories only (no pairs); `Workspace` searches that workspace's pairs plus
  that workspace's memories and the global memories. While a search is active
  the mode toggle is disabled; changing scope, **Refresh**, a successful
  **Re-index** / **Forget**, or re-entering the tab re-runs it, and **Clear**
  returns to the current mode's normal list.
- **Shared search pipeline**: Browse search reuses the same cosine + optional
  rerank scoring stage as retrieval (`lib/ranking.js`) with the configured
  `minScore` / `rerankMinScore` / `rerank.enabled` and `scanLimit`, but has no
  session context — it applies no same-session exclusion, turn dedupe, or
  `minMessageLength`, and does not use the injection-only
  `candidateLimit`/`topK`. It only requires embedding to be enabled and
  configured; only index rows with the current embedding model/dim are scored
  (missing/pending/model-mismatched entries simply do not appear). Search
  errors are surfaced in the GUI (unlike recall's fail-open injection); a
  rerank failure falls back to cosine scores with a note, and the plugin's own
  log lines and error messages never contain the query text (an upstream
  endpoint could still echo it in its own error body).
- **Browse search is read-only**: hits are re-resolved against the
  authoritative JSONL/Markdown sources and orphaned index rows are dropped
  (`stats.excludedOrphan`); raw vectors and full `userText`/`assistantText`/
  memory `content` are never returned by `browse.search` (memory content stays
  available through the separate `browse.get` detail action). The engine
  behind it, `lib/search.js` (kept in `deps.search`), is the reusable service
  for a future agent tool; **no agent tool is registered in this cycle**.
