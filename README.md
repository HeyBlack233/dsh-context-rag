# dsh-context-rag

A [DeepSeek Harness](https://github.com/deepseek-ai/dsh) (DSH) plugin that adds
retrieval-augmented generation (RAG) to DSH sessions.

## Purpose

After each turn, the plugin stores the (user message, final assistant reply)
pair in a human-readable JSONL store and indexes its embedding in SQLite.
Before each model step, it retrieves similar past pairs from the current
workspace (or all workspaces), optionally reranks them, and injects the top
results as a read-only context message. The injected context is shown in the
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
- **Pre-step durable context injection** shown in the Trajectory.
- **Configure page** in the Plugins row of the DSH Web GUI, with **English and
  Simplified Chinese** UI.

## Install

Install from a local path:

```bash
dsh plugin add /path/to/dsh-context-rag
```

or use the Plugins page in the DSH Web GUI and choose the local install flow.

## Quick configuration

Open the plugin's Configure page (Plugins row) and set:

- `baseUrl` — your OpenAI-compatible embeddings endpoint, e.g.
  `https://api.openai.com/v1`.
- `model` — the embedding model name.
- `key` — the API key for the embeddings/rerank endpoint.
- Enable **rerank** if you want candidates re-ranked before injection.
- `scope` — `workspace` (default) or `all`.

Defaults: `topN = 20`, `topK = 5`, `minScore = 0.4`.

## Data layout

Everything lives under `$DSH_HOME/context-rag`:

- `config.json` — plugin configuration.
- `pairs/*.jsonl` — human-readable (user message, final assistant reply) pairs.
- `index.sqlite` — the embedding index (rebuildable from `pairs/*.jsonl`).

## How it works

- **Turn-stopping write**: after the turn completes, the plugin stops the turn
  to durably store the pair and enqueue its embedding.
- **Pre-step read**: before the next model step, it retrieves candidates and
  (optionally) reranks them, then injects the top results as a read-only
  context message that appears in the Trajectory.
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
