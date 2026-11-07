# Testing

This page describes how to run the checks and tests, what the test suite
covers, and how to manually verify the plugin end-to-end in a live profile.

## Commands

| Command | What it does |
| --- | --- |
| `npm run check` | Syntax-checks every JavaScript file with `node --check`. |
| `npm test` | Runs the test suite with the Node test runner (`node --test`). |

Run both before opening a change; `npm run check` is fast and catches syntax
errors, while `npm test` exercises behavior.

The suite spans the test files listed below, and the exact number of tests
grows as the suites are extended — run `npm test` for the current count. Both
`npm run check` and `npm test` should be green (all pass, no failures) before
opening a change.

## Test layout

Tests live under `test/` as `test/*.test.js`. Shared helpers are in
`test/helpers/`:

```
test/
├── api.test.js
├── capture.test.js
├── client-static.test.js
├── config.test.js
├── db.test.js
├── embeddings.test.js
├── http.test.js
├── indexer.test.js
├── inject.test.js
├── integration.test.js
├── manifest.test.js
├── memories.test.js
├── memory-tools.test.js
├── pairs.test.js
├── paths.test.js
├── recall-state.test.js
├── render.test.js
├── rerank.test.js
├── retrieval.test.js
├── text.test.js
└── helpers/
    ├── http-server.js   # local fake HTTP server for endpoint tests
    └── tmp.js           # temporary-directory helpers
```

## What the suites cover

| Suite | Focus |
| --- | --- |
| `config` | Config load, validation, persistence, and API-key redaction. |
| `paths` | Data-home resolution and every path underneath it. |
| `text` | Text normalization and character truncation. |
| `pairs` | Reading/appending the JSONL pair log and text-hash computation. |
| `db` | SQLite schema creation (including the non-destructive memory-column migration), connection handling, and atomic writes. |
| `http` | The shared HTTP client behavior (timeouts, retries, errors). |
| `embeddings` | Calling the embedding API and producing normalized vectors. |
| `rerank` | The optional OpenAI-compatible rerank endpoint call. |
| `capture` | Turn-stopping capture: what to store and outbox enqueueing. |
| `indexer` | Background worker: draining the outbox (pairs and memories), batching, retry. |
| `render` | Building the injected context text from retrieved pairs and memories. |
| `retrieval` | Query embedding, candidate scan over pairs and memories, scoring, and top-K selection. |
| `recall-state` | Persistent turn-dedupe state: load/prune/record/remove/eligibility, retention by days and max sessions, corrupt/missing-file handling, and atomic persistence. |
| `inject` | Dedupe per user message and attaching the injected context message. |
| `memories` | Memory store: Markdown + YAML front matter, `MEMORY.md` index maintenance, `.forgotten` handling, name/content validation, and the startup sync scan. |
| `memory-tools` | The `memory_list` / `memory_get` / `memory_write` / `memory_forget` tools: scoping to global or the current workspace, overwrite/duplicate rules, exact-match forgetting, turn-dedupe recording on write and cleanup on forget, and error mapping. |
| `api` | The host-facing HTTP API, trust checks, actions, and error mapping. |
| `integration` | Real modules end-to-end: `apply()` listener/API registration, capture → JSONL → SQLite → indexer → retrieval → injection, memory tools → Markdown files → `MEMORY.md` index → shared outbox → memory + pair recall, turn dedupe for both injections and memory writes, workspace/all scope, same-session exclusion, rerank fallback, disabled indexing, and render budget. |
| `manifest` | Package/exports/bundle patch/locales/docs consistency, and the no-icon contract. |
| `client-static` | Static browser-half contracts: slot key, bound locale registration, status shape, form fields, theme tokens, and EN/ZH key parity. |

The `integration` suite is the end-to-end proof; the `api` suite covers the
HTTP boundary itself.

## Local fake HTTP servers

Endpoint-dependent tests do **not** touch the real network. They spin up local
fake HTTP servers (see `test/helpers/http-server.js`) that stand in for the
embedding and rerank APIs. This keeps the suite hermetic, fast, and
deterministic — no external service is required and no request leaves the
machine. Temporary directories for these tests come from
`test/helpers/tmp.js`.

## CI

The plugin is tested on **Node 22** and **Node 24** in CI (see the GitHub
Actions workflow under `.github/`). Both `npm run check` and `npm test` run on
each Node version. Any Node 22/24-compatible runtime is expected to pass.

## Manual live verification

For a real end-to-end check, install the bundle into a profile and exercise a
live session:

1. **Install into a profile** — install `@local/dsh-context-rag` into a
   profile so the plugin is active.
2. **Configure endpoints** — open the configuration page (see
   [configuration-page.md](configuration-page.md)) and set an embedding
   `baseUrl` and `model`; use **Test** to validate, then **Save**. Optionally
   point the reranker at a rerank endpoint.
3. **Complete a turn** — send a direct user message and let the assistant
   reply. The write path stores the pair.
4. **Check the JSONL / SQLite / outbox** — inspect `pairs/<workspace-slug>/
   <session-slug>.jsonl` for the new entry, and confirm the SQLite index and
   outbox state (see [operations.md](operations.md) for paths).
5. **Send a second message** — the read path should now retrieve the earlier
   pair.
6. **Inspect the Trajectory** — open the Trajectory view for the session and
   confirm a `context-rag` context row is present (chat hides it; Trajectory
   shows it).
7. **Switch scope** — change the retrieval `scope` to `all` and confirm pairs
   from other workspaces become eligible.
8. **Enable rerank** — turn on `rerank.enabled`, point it at a working rerank
   endpoint, and confirm candidates are reranked.
9. **Rebuild the index** — trigger `index.rebuild` and confirm the index is
   rebuilt from JSONL.
10. **Check the recall filters** — with `allowSameSession` `false` (default),
    earlier pairs from the same session are not recalled; with
    `dedupeTurns` set, recently injected pairs are not re-injected within the
    turn distance, and `recall-state.json` appears in the data home. After a
    `memory_write`, confirm the written memory is not recalled again in the
    same session until the turn window has passed.
11. **Exercise the memory tools** — ask the assistant to save a note
    (`memory_write`), list memories (`memory_list`), read one (`memory_get`),
    and forget it (`memory_forget`). Confirm `<name>.md` appears in
    `memories/workspaces/<workspace-slug>/` (or `memories/global/`), the
    `MEMORY.md` index is updated, and the forgotten file is renamed to
    `<name>.forgotten`.
12. **Check memory recall** — start a new session in the same workspace and ask
    about the saved topic; the memory should be injected alongside pair
    candidates. Edit a memory file by hand and restart the plugin; the startup
    scan should pick up the change (there is no real-time watcher).

See [operations.md](operations.md) for the data paths and
[retrieval-and-injection.md](retrieval-and-injection.md) for how injected
context appears.
