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

- Store each turn's (user message, final assistant reply) pair in a
  human-readable JSONL store, indexed with embeddings in SQLite.
- Embedding indexer with an outbox: pairs are queued for embedding and the
  SQLite index can be rebuilt from the JSONL store.
- Workspace-scoped or all-workspace retrieval of similar past pairs, with
  optional rerank via a Jina / Cohere / SiliconFlow-compatible `/v1/rerank`
  endpoint.
- Pre-step durable context injection: retrieved pairs are injected as a
  read-only context message shown in the Trajectory.
- Cosine and rerank score thresholds are separate settings: `minScore` filters
  cosine similarity before reranking, and `rerankMinScore` filters the rerank
  relevance score. Both range from `0.00` to `1.00` with two decimals.
- Configure panel on the plugin's page in the DSH Web GUI, above the
  **Components** section (no separate row page): separate cards for the
  embedding, rerank, retrieval, and indexing settings, an advanced JSON view,
  write-only API-key handling, and English/Simplified Chinese UI.
- Same-session recall is now **off by default**: `retrieval.allowSameSession`
  (default `false`) excludes pairs from the current session in all recall modes;
  set it to `true` to allow them. Forked/derived sessions count as different
  sessions.
- Injection-only turn dedupe: `retrieval.dedupeTurns` (default `5`) keeps a pair
  from being re-injected until `T - L >= dedupeTurns`; `0` disables turn dedupe
  and `-1` allows each pair at most once per session, ever. Only pairs actually
  rendered into the injected context are recorded.
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
- Tests, documentation, and a CI workflow covering the plugin.
