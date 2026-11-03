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
- Configure panel on the plugin's page in the DSH Web GUI, above the
  **Components** section (no separate row page): separate cards for the
  embedding, rerank, retrieval, and indexing settings, an advanced JSON view,
  write-only API-key handling, and English/Simplified Chinese UI.
- Tests, documentation, and a CI workflow covering the plugin.
