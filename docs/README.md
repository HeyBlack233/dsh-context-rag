# dsh-context-rag Documentation

This directory holds the documentation for the `dsh-context-rag` plugin,
which adds retrieval-augmented generation (RAG) to DeepSeek Harness (DSH)
sessions: after each turn it stores the (user message, final assistant reply)
pair in a human-readable JSONL store, indexes its embedding in SQLite, and
before each model step retrieves similar past pairs from the current
workspace (or all workspaces), optionally reranks them, and injects the top
results as a read-only context message.

## Documentation index

| Document | Description |
| --- | --- |
| [architecture.md](architecture.md) | End-to-end overview: the two data flows, module map, and lifecycle. |
| [configuration.md](configuration.md) | Every configurable field and its default, for all subsystems. |
| [storage-and-data-model.md](storage-and-data-model.md) | Data home, the JSONL pair log, and the SQLite index. |
| [retrieval-and-injection.md](retrieval-and-injection.md) | The read path: query, candidate scan, scoring, and injection. |
| [configuration-page.md](configuration-page.md) | The GUI config page: sections, actions, API-key handling, and bilingual UI. |
| [testing.md](testing.md) | How to run checks/tests, what the suites cover, and manual verification. |
| [security-and-privacy.md](security-and-privacy.md) | Local storage, API-key handling, scope, and the prompt-injection caveat. |
| [operations.md](operations.md) | Data paths, backup, index maintenance, failure modes, and upgrades. |
