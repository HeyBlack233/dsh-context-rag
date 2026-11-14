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
  `<memory>`, `<user>`, `<assistant>`, `<content>`) with metadata in
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
