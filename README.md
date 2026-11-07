# dsh-context-rag

A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (DSH) plugin that adds
retrieval-augmented generation (RAG) to DSH sessions.

## Purpose

After each turn, the plugin stores the (user message, final assistant reply)
pair in a human-readable JSONL store and indexes its embedding in SQLite.
Before each model step, it retrieves similar past pairs from the current
workspace (or all workspaces), optionally reranks them, and injects the top
results as a read-only context message. Persistent **memories** — Markdown
notes saved through the `memory_list` / `memory_get` / `memory_write` /
`memory_forget` tools — are recalled alongside conversation pairs from the
global store and the current workspace. The injected context is shown in the
Trajectory so you can see exactly what was retrieved and used.

## Features

- **JSONL pair store** with a **rebuildable SQLite index/outbox**: each turn's
  pair is appended to a JSONL file and queued for embedding; the index can be
  rebuilt from the store at any time.
- **OpenAI-compatible embeddings** for indexing and querying.
- Optional **Jina / Cohere / SiliconFlow-compatible `/v1/rerank`** support to
  re-rank the initial candidates before injection.
- **Workspace or all-scope** retrieval: search the current workspace by default,
  or across all workspaces.
- **Same-session recall is off by default**: pairs from the current session are
  excluded unless you enable `allowSameSession`; forked/derived sessions count
  as different sessions.
- **Turn-distance dedupe** for context injection: a pair or memory is not
  recalled again until `dedupeTurns` turns have passed (`0` disables turn
  dedupe; `-1` allows each candidate only once per session, ever). A successful
  `memory_write` counts as a recall at the current turn, so a just-written
  memory stays out of the recent window. The bookkeeping lives in a separate,
  persistent `recall-state.json`, pruned by `dedupeStateRetentionDays` and
  `dedupeStateMaxSessions`; forgetting a memory clears its entries.
- **Pre-step durable context injection** shown in the Trajectory.
- **Persistent memories**: `memory_list` / `memory_get` / `memory_write` /
  `memory_forget` manage Markdown notes under `memories/global/` and
  `memories/workspaces/<workspace-slug>/`, each with YAML front matter and a
  `MEMORY.md` index. Memories are recalled together with conversation pairs
  through the same embedding/retrieval pipeline (global + current workspace,
  independent of `retrieval.scope`); `memory_forget` renames a file to
  `<name>.forgotten`, keeping its history while removing it from the index and
  SQLite.
- **Configure panel** on the plugin's page in the DSH Web GUI (above the
  **Components** section), with **English and Simplified Chinese** UI.

## Install

Install from a local path:

```bash
dsh plugin add /path/to/dsh-context-rag
```

or use the Plugins page in the DSH Web GUI and choose the local install flow.

## Quick configuration

Open the plugin's page in the Plugins view of the DSH Web GUI and use the
configuration panel above the **Components** section:

- `baseUrl` — your OpenAI-compatible embeddings endpoint, e.g.
  `https://api.openai.com/v1`.
- `model` — the embedding model name.
- `key` — the API key for the embeddings/rerank endpoint.
- Enable **rerank** if you want candidates re-ranked before injection.
- `scope` — `workspace` (default) or `all`.

Defaults: `candidateLimit = 20`, `topK = 5`, `minScore = 0.40`,
`rerankMinScore = 0.40`. `minScore` filters cosine similarity before reranking;
`rerankMinScore` filters the reranker's relevance score. Both range from `0.00`
to `1.00` with two decimals.

Recall defaults: `allowSameSession = false` (same-session recall off),
`dedupeTurns = 5` (injection-only turn dedupe, also counting memory writes;
`0` disables, `-1` = once per session ever), `dedupeStateRetentionDays = 90`
and `dedupeStateMaxSessions = 500` (recall-state retention; `0` disables the
corresponding limit).

## Data layout

Everything lives under `$DSH_HOME/context-rag`:

- `config.json` — plugin configuration.
- `pairs/*.jsonl` — human-readable (user message, final assistant reply) pairs.
- `memories/` — Markdown memory files (`global/` and
  `workspaces/<workspace-slug>/`, each with a `MEMORY.md` index).
- `index.sqlite` — the embedding index (rebuildable from `pairs/*.jsonl` and
  the memory files).
- `recall-state.json` — turn-dedupe history (ids/turns/timestamps/counts only;
  safe to delete — dedupe history resets).

## How it works

- **Turn-stopping write**: after the turn completes, the plugin stops the turn
  to durably store the pair and enqueue its embedding.
- **Memory write**: `memory_write` writes the Markdown file and refreshes the
  `MEMORY.md` index first (the file write is the commit point), then enqueues
  the embedding through the same outbox and records the memory at the current
  turn for turn dedupe.
- **Pre-step read**: before the next model step, it retrieves candidates —
  conversation pairs plus global/current-workspace memories — and (optionally)
  reranks them, then injects the top results as a read-only context message
  that appears in the Trajectory.
- **Fail-open**: if embeddings or retrieval fail, the step proceeds without
  injected context rather than blocking the conversation.

## Documentation

- [Documentation index](docs/README.md)
- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Storage and Data Model](docs/storage-and-data-model.md)
- [Retrieval and Injection](docs/retrieval-and-injection.md)
- [Configuration Page](docs/configuration-page.md)
- [Testing](docs/testing.md)
- [Security and Privacy](docs/security-and-privacy.md)
- [Operations](docs/operations.md)

No SVG icon is shipped in this cycle.

## Development

```bash
npm run check   # node --check on all JS files
npm test        # node --test
```

## License

MIT
