# Testing

This page describes how to run the checks and tests, what the test suite
covers, and how to manually verify the plugin end-to-end in a live profile.

## Commands

| Command | What it does |
| --- | --- |
| `npm run check` | Syntax-checks every JavaScript file with `node --check`. |
| `npm test` | Runs the test suite with the Node test runner (`node --test`). |
| `npm run compat` | Asserts the declared DSH range with the running installation's own compatibility evaluator (requires `DSH_INSTALL_DIR`, or `--app-boot <path>`). |

Run `check` and `test` before opening a change; `npm run check` is fast and
catches syntax errors, while `npm test` exercises behavior. `npm run compat`
only matters when the DSH compatibility range changes — see
[compatibility.md](compatibility.md).

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
├── browse.test.js
├── capture.test.js
├── client-static.test.js
├── config.test.js
├── db.test.js
├── embeddings.test.js
├── http.test.js
├── indexer.test.js
├── inject.test.js
├── integration.test.js
├── log-buffer.test.js
├── manifest.test.js
├── memories.test.js
├── memory-tools.test.js
├── pairs.test.js
├── paths.test.js
├── recall-state.test.js
├── render.test.js
├── rerank.test.js
├── retrieval.test.js
├── search.test.js
├── text.test.js
└── helpers/
    ├── http-server.js   # local fake HTTP server for endpoint tests
    └── tmp.js           # temporary-directory helpers
```

## What the suites cover

| Suite | Focus |
| --- | --- |
| `config` | Config load, validation, persistence, API-key redaction, the `minMessageLength` bounds, and the logging settings (`logging.bufferSize` bounds and the `logging.debug` boolean). |
| `paths` | Data-home resolution and every path underneath it. |
| `text` | Text normalization, `minMessageLength` word/Han counting, and character truncation. |
| `pairs` | Reading/appending the JSONL pair log and text-hash computation. |
| `db` | SQLite schema creation (including the non-destructive memory-column migration), connection handling, atomic writes, the lightweight `indexRows()` view (text hash, model/dim, embedding byte length, outbox join) that backs the browse/audit service, and the `searchCandidates({scope, kinds, model, dim, limit})` manual-search candidate query (scope/kind merging with recall memory semantics, model/dim filtering, limit/default, validation). |
| `http` | The shared HTTP client behavior (timeouts, retries, errors). |
| `embeddings` | Calling the embedding API and producing normalized vectors. |
| `rerank` | The optional OpenAI-compatible rerank endpoint call. |
| `capture` | Turn-stopping capture: what to store, the short-message skip (no JSONL/DB/outbox), and outbox enqueueing. |
| `indexer` | Background worker: draining the outbox (pairs and memories), batching, retry; plus the single-entry synchronous re-index (`reindexEntry`): fresh source re-read, outbox fallback with `{queued: true}` on failure, and the text-hash compare-and-swap that refuses to overwrite newer text. |
| `browse` | The browse/audit service (`lib/browse.js`): scope discovery with per-scope counts, paged listing (memories by name, pairs newest first), per-entry detail reads (200-char previews, 200,000-char text caps with truncation flags, outbox info), the full scope audit — status counts, the 500-entry mismatch cap with the `truncated` flag, orphan reporting, and malformed-JSONL-line counting — and the manual search: scope normalization, shaped memory+pair items with no engine-metadata leakage (raw vectors, `userText`/`assistantText`, and memory `content` never reach the client), orphan dropping with `stats.excludedOrphan`, engine-stats merging, score-descending order, and `NOT_READY` (503) when no search engine is configured. It pins the `computeStatus` precedence (`missing` → `stale-text` → `pending` → `corrupt` → `model-mismatch` → `consistent`), the fail-open `unknown` state, and the model/dim check being skipped when no embedding model is configured. |
| `render` | Building the injected context text from retrieved pairs and memories. |
| `retrieval` | Query embedding, candidate scan over pairs and memories, scoring via the shared `lib/ranking.js` stage, and top-K selection. |
| `search` | The manual search service (`lib/search.js`): query trimming and the `INVALID_INPUT` (400) / `EMBEDDING_NOT_CONFIGURED` (409) errors, cosine scoring with `minScore` and the final limit, rerank reordering with `rerankMinScore` and `topN = limit`, the 50-result cap, the cosine fallback with `stats.rerankError`, scope/kinds/model/dim/scanLimit forwarding, stats reporting, signal/timeout handling, and the guarantee that the query text never appears in log lines. |
| `recall-state` | Persistent turn-dedupe state: load/prune/record/remove/eligibility, retention by days and max sessions, corrupt/missing-file handling, and atomic persistence. |
| `inject` | Per-user-message dedupe, the short-message gate, and attaching the injected context message. |
| `memories` | Memory store: Markdown + YAML front matter, `MEMORY.md` index maintenance, `.forgotten` handling, name/content validation, the startup sync scan, and the exact-match `remove` shared by `memory_forget` and forget-from-Browse. |
| `memory-tools` | The `memory_list` / `memory_get` / `memory_write` / `memory_forget` tools: scoping to global or the current workspace, overwrite/duplicate rules, exact-match forgetting, turn-dedupe recording on write and cleanup on forget, and error mapping. |
| `log-buffer` | The in-memory ring buffer: latest-N window and trimming, logger tee, text serialization, and export (file naming, collision suffix, header, and mode `0600`). |
| `api` | The host-facing HTTP API, trust checks, actions (including `logs.get`, `logs.configure`, `logs.export`, and the `browse.*` family — scope validation, kind/paging validation, the audit, the manual search `browse.search` (query trimming and the 2000-char cap, limit 1..50, scope validation, engine construction from shared deps, stable error mapping), single-entry re-index, and forget), and error mapping. |
| `integration` | Real modules end-to-end: `apply()` listener/API registration, capture → JSONL → SQLite → indexer → retrieval → injection, the short-message gate suppressing both capture and injection, memory tools → Markdown files → `MEMORY.md` index → shared outbox → memory + pair recall, turn dedupe for both injections and memory writes, workspace/all scope, same-session exclusion, rerank fallback, disabled indexing, and render budget. Logging is covered end-to-end too: the logger tee feeds the ring buffer, config changes resize it, and an export writes the `logs/` file. |
| `manifest` | Package/exports/bundle patch/locales/docs consistency, the DSH compatibility range, and the no-icon contract. |
| `client-static` | Static browser-half contracts: slot key, bound locale registration, status shape, tab wiring (four tabs, Dashboard → Browse → Configuration → Logs) and accessibility, the Browse tab (mode/scope controls, split view, status pills, manual search: the search form with Search/Clear, `browse.search` calls with the 20-result `BROWSE_SEARCH_LIMIT`, mixed result rows with kind badge and score pill, re-run on scope change/refresh/re-index/forget, mode toggle disabled while a search is active, only-mismatched exiting the search, and the EN/ZH search keys; plus the check-index audit, re-index and two-click forget, lazy load without polling, page size 20, preview/truncation caps, theme-token status colors, EN/ZH key parity), the Logs tab (log list, N input, debug toggle, export button, and active-tab auto-refresh), action placement, collapsible advanced JSON, form fields, theme tokens, and EN/ZH key parity. |

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
   [configuration-page.md](configuration-page.md)), switch to the
   **Configuration** tab, and set an embedding `baseUrl` and `model`; use
   **Test** to validate, then **Save**. Optionally point the reranker at a
   rerank endpoint.
3. **Complete a turn** — send a direct user message (at least
   `retrieval.minMessageLength` units; default `8`) and let the assistant reply.
   The write path stores the pair.
4. **Check the short-message gate** — with the default threshold, send a very
   short message (for example `hi`). Confirm no new JSONL line, SQLite row, or
   outbox entry appears and no `context-rag` context is injected. Set
   `retrieval.minMessageLength = 0` and repeat to confirm the gate is disabled.
5. **Check the JSONL / SQLite / outbox** — inspect `pairs/<workspace-slug>/
   <session-slug>.jsonl` for the new entry, and confirm the SQLite index and
   outbox state (see [operations.md](operations.md) for paths).
6. **Send a second message** — the read path should now retrieve the earlier
   pair.
7. **Inspect the Trajectory** — open the Trajectory view for the session and
   confirm a `context-rag` context row is present (chat hides it; Trajectory
   shows it).
8. **Switch scope** — change the retrieval `scope` to `all` and confirm pairs
   from other workspaces become eligible.
9. **Enable rerank** — turn on `rerank.enabled`, point it at a working rerank
   endpoint, and confirm candidates are reranked.
10. **Rebuild the index** — on the **Dashboard** tab, trigger **Rebuild index**
    and confirm the index is rebuilt from JSONL; switching tabs while the
    operation runs should keep the busy indicator and result banner visible.
11. **Check the recall filters** — with `allowSameSession` `false` (default),
    earlier pairs from the same session are not recalled; with
    `dedupeTurns` set, recently injected pairs are not re-injected within the
    turn distance, and `recall-state.json` appears in the data home. After a
    `memory_write`, confirm the written memory is not recalled again in the
    same session until the turn window has passed.
12. **Exercise the memory tools** — ask the assistant to save a note
    (`memory_write`), list memories (`memory_list`), read one (`memory_get`),
    and forget it (`memory_forget`). Confirm `<name>.md` appears in
    `memories/workspaces/<workspace-slug>/` (or `memories/global/`), the
    `MEMORY.md` index is updated, and the forgotten file is renamed to
    `<name>.forgotten`.
13. **Check memory recall** — start a new session in the same workspace and ask
    about the saved topic; the memory should be injected alongside pair
    candidates. Edit a memory file by hand and restart the plugin; the startup
    scan should pick up the change (there is no real-time watcher).
14. **Check the Logs tab** — on the configuration page, open the **Logs** tab:
    adjust the N input (for example to `50`) and click **Apply**, enable the
    **debug** checkbox, then trigger a warning or error (for example, a failing
    embedding request or a `memory_forget` for a name that does not exist) and
    click **Write to disk**. Confirm the page shows the exported file path, a
    new `context-rag-*.log` file appears under `$DSH_HOME/context-rag/logs/`
    (host-local timestamp; `-1`/`-2` suffix on collision), and that the log
    list refreshes while the tab stays active and stops after you leave it.
15. **Check the Browse tab** — open the **Browse** tab (second tab, after
    **Dashboard**). Confirm the Memories/Pairs mode switch, the scope filter
    (`All` / `Global` / workspaces; `Global` is memories-only), the split
    list/detail layout, status pills per row, and **Load more** paging (20
    entries per page). Confirm nothing loads while the tab is hidden (lazy
    load on entry) and there is no polling.
16. **Run Check index** — click **Check index** and confirm the summary line
    (pairs/memories/total, per-status counts) and the **Only mismatched**
    filter. Hand-edit a pair line in `pairs/` (or a memory file) so its text
    differs from the indexed copy, refresh the list, and confirm the entry now
    shows **Stale text**; click **Check index** again and confirm the entry
    appears under the mismatched counts. There is no automatic audit — nothing
    changes until you click.
17. **Re-index one entry** — with an embedding endpoint configured, select the
    stale entry and click **Re-index**; confirm the status becomes
    **Consistent** and the model/dim/indexed-at metadata updates. Stop the
    endpoint (or point it at a failing URL), re-index a pending entry, and
    confirm the failure message keeps the entry queued in the outbox (the
    detail shows the outbox reason/attempts/last error). Clear the embedding
    `model` and confirm the **Re-index** button is disabled.
18. **Forget from Browse** — select a memory and click **Forget** twice
    (two-click confirmation; the label changes on the first click). Confirm
    the row disappears, `memories/.../<name>.md` was renamed to
    `<name>.forgotten` (still on disk), the `MEMORY.md` index no longer lists
    it, and its SQLite row and recall-state entries are gone. Verify leaving
    the tab disarms a pending confirmation.
19. **Search from Browse** — with an embedding endpoint configured, type a
    query into the Browse search box and click **Search** (or press Enter).
    Confirm the result list mixes memories and message pairs (each row shows a
    kind badge, a `Score 0.xxx` pill marked `cosine` or `Rerank`, and the
    index-status pill), that an empty query does nothing, and that the
    Memories/Pairs mode toggle is disabled while a search is active. Change
    the scope and confirm the search re-runs against the new scope; click
    **Refresh** and confirm the active search re-runs. Enable **Only
    mismatched** and confirm the search exits; clear the search and confirm
    the current mode's normal list returns. With `rerank.enabled` on, stop the
    rerank endpoint and re-run a search to confirm the fallback note ("Rerank
    unavailable — cosine scores shown") appears. Disable embedding (or clear
    `model`/`baseUrl`) and confirm the search reports a failure without
    echoing the query text.

See [operations.md](operations.md) for the data paths and
[retrieval-and-injection.md](retrieval-and-injection.md) for how injected
context appears.
