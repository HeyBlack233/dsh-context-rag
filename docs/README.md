# dsh-context-rag Documentation

This directory holds the documentation for the `dsh-context-rag` plugin,
which adds retrieval-augmented generation (RAG) to DeepSeek Harness (DSH)
sessions: after each turn it stores the (user message, final assistant reply)
pair in a human-readable JSONL store, indexes its embedding in SQLite, and
before each model step retrieves similar past pairs from the current
workspace (or all workspaces), optionally reranks them, and injects the top
results as a read-only context message. Persistent **memories** — Markdown
notes under `memories/` with a `MEMORY.md` index, managed through the
`memory_list` / `memory_get` / `memory_write` / `memory_forget` tools — are
recalled alongside conversation pairs from the global store and the current
workspace. Recall is filtered by default: same-session pairs are excluded
unless `allowSameSession` is enabled, and recently injected pairs are deduped
by turn distance in injection mode, with the dedupe history kept in a separate
`recall-state.json`.

## Documentation index

| Document | Description |
| --- | --- |
| [architecture.md](architecture.md) | End-to-end overview: the two data flows (conversation pairs + memories), module map, and lifecycle. |
| [configuration.md](configuration.md) | Every configurable field and its default, for all subsystems; memory recall reuses the embedding/retrieval settings. |
| [storage-and-data-model.md](storage-and-data-model.md) | Data home, the JSONL pair log, the memory Markdown files, the SQLite index, and the recall-state file. |
| [retrieval-and-injection.md](retrieval-and-injection.md) | The read path: query, candidate scan over pairs and memories, scoring, and injection. |
| [configuration-page.md](configuration-page.md) | The GUI config panel on the plugin page: sections, actions, API-key handling, and bilingual UI. |
| [testing.md](testing.md) | How to run checks/tests, what the suites cover, and manual verification. |
| [security-and-privacy.md](security-and-privacy.md) | Local storage, API-key handling, scope, and the prompt-injection caveat for pairs and memories. |
| [operations.md](operations.md) | Data paths, backup, index maintenance, memory sync, failure modes, and upgrades. |
