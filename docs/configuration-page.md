# Configuration Page

`context-rag` is configured through a dedicated page in the Harness GUI. This
page describes how that page is wired up, what tabs and sections it shows, what
actions it exposes, and how API keys are handled. For the underlying config
fields and their defaults, see [configuration.md](configuration.md).

> This document uses `context-rag` as the short plugin name. The installable
> bundle identifier is `@local/dsh-context-rag`.

## How the page is wired

The page is the plugin's web client (`client.js`). It is registered on the
**Plugins** page as the bundle's own configuration panel: the panel renders on
the `@local/dsh-context-rag` bundle detail page between the description and the
**Components** section, so there is no separate row page or secondary menu.
The wiring is declared under the `plugins.bundle.config` key, using the bundle
package name `@local/dsh-context-rag` as the key.

All reads and writes go through the plugin's internal API exposed to the host
at a single endpoint:

```
POST /plugins/dsh-context-rag/api
```

Requests carry a JSON body with an `action` field naming which operation to
perform (see [Actions](#actions)). The host routes the call to `lib/api.js`,
which reads or writes the runtime config and talks to the worker where needed.
The API is same-origin and only reachable inside the running harness, so no
secret leaves the machine (see [security-and-privacy.md](security-and-privacy.md)).

## Layout

The page keeps a compact **status strip** above the tabs, so the index counts
and indexer state stay visible while editing settings:

- pair / indexed / pending / error counts;
- indexer running state;
- a **Refresh** button that re-reads the saved config and runtime status.

Below the strip are four tabs, in order — **Dashboard**, **Browse**,
**Configuration**, and **Logs**. The selected tab is remembered in
`localStorage` (`dsh-context-rag:tab`) and survives a page refresh. Switching
tabs never discards edits: the Dashboard and Configuration tabs render from the
same page state.

### Dashboard

The Dashboard is the monitoring and index-maintenance view. It is read-only
for configuration:

- **Status** — data home, embedding model, dimension, indexer state, and the
  init/last errors;
- **Index maintenance** — index file count, index size, and the **Rebuild
  index** / **Clear index** actions. Rebuild re-embeds every stored pair from
  the JSONL log; Clear removes index rows and the pending outbox but keeps the
  pair log. Both use a two-click confirmation. Leaving the tab disarms a
  pending confirmation.

### Browse

The Browse tab is the read-only inspection and repair view over the stored
data — memories and message pairs — with per-entry index-consistency status.
Everything it lists comes from the sources of truth (the JSONL pair files and
the Markdown memory files); the SQLite index only supplies status. The tab
loads its data lazily on entry: nothing is fetched or polled while the tab is
hidden, and there is **no search** and **no polling** while it is active.

- **Mode switch** — a **Memories** / **Pairs** toggle switches the dataset.
  Memories cover the global store and every workspace; pairs cover the
  captured message pairs.
- **Scope filter** — `All` (everything), `Global` (global memories only — a
  memories-only scope, so it is not offered when browsing pairs), and one entry
  per workspace that has stored data. The scope selector shows the workspace
  name and a short slug. Switching scope or mode reloads the list and clears
  the selection.
- **Split view** — the list (left) and the detail of the selected entry
  (right) are laid out side by side and **stack vertically at ≤ 720 px**
  (`@media (max-width: 720px)` flips the split to a column; the list is capped
  at 45 vh on narrow screens).
- **List rows** — each row shows a status pill plus the entry identity:
  memory rows show the name, a Global/Workspace badge, description, and
  creation time; pair rows show a whitespace-normalized **preview of the user
  message capped at 200 characters** (assistant text is never previewed), a
  workspace basename, the last 8 characters of the session id, the turn
  number, and the creation time. Rows are sorted: memories by name, pairs
  newest first.
- **Status pills** — every entry carries an index-consistency status pill:
  `consistent`, `missing`, `stale-text`, `pending`, `model-mismatch`,
  `corrupt`, `orphan` (shown as *Index residue* in the UI), or `unknown`
  (fail-open). See
  [storage-and-data-model.md](storage-and-data-model.md#index-consistency-states)
  for the definitions and precedence.
- **Detail** — clicking a row (orphan rows are disabled — they have no source
  to show) reads the entry fresh: full metadata (id, session, workspace, turn,
  creation time, status, indexed model/dim/indexed-at), the outbox state for
  pending entries (reason, attempts, last error), and the full text — memory
  content, or the user message and assistant reply. Each text field is capped
  at **200,000 characters** and a *Content too long — truncated* note appears
  when the cap was hit.
- **Check index** — the **Check index** button runs `browse.check`, a full
  on-demand audit of the current scope: counts per status, the checked pair /
  memory totals, mismatched entries (capped at 500, with a *Check truncated*
  note when more exist), orphans, and the number of malformed JSONL lines.
  There is **no automatic or periodic audit**; checks only run when you click.
  The **Only mismatched** checkbox then swaps the list to show just the
  non-consistent entries from the last check.
- **Per-entry re-index** — non-consistent, non-orphan entries get a
  **Re-index** button that synchronously re-embeds the single entry through
  the configured embedding endpoint (see
  [operations.md](operations.md#index-consistency-check-and-repair)). It is
  disabled while no embedding model is configured; a failed re-index leaves
  the entry queued in the outbox for the background retry.
- **Forget memory** — memory entries get a **Forget** button with a
  two-click confirmation (the label changes to *Click again to confirm*; the
  confirmation is disarmed by leaving the tab or changing selection/scope/
  mode). It runs `browse.forget` with the exact same semantics as the
  `memory_forget` tool: `<name>.md` is renamed to `<name>.forgotten`, the
  `MEMORY.md` index is rebuilt, the index row and its outbox entry are
  deleted, and the memory's recall-state entries are cleared. History stays on
  disk — nothing is hard-deleted.
- **Pagination** — lists load one page at a time, **20 entries per page**,
  with a **Load more** button that appends the next page. Everything else is
  read-only: the Browse tab never edits config, never rewrites the pair log or
  memory files, and has no data-entry controls.

### Configuration

The Configuration tab holds all editing surfaces:

- **Settings** — four separate cards, one per configuration category, each
  with its own responsive form:
  - **Embedding** — `enabled`, `baseUrl`, `model`, `dimensions`, `apiKey`,
    `timeoutMs`, `maxRetries`, `batchSize`, `maxEmbeddingChars`;
  - **Rerank** — `enabled`, `baseUrl`, `model`, `path`, `apiKey`;
  - **Retrieval** — `injectionEnabled`, `allowSameSession`,
    `minMessageLength`, `scope` (`workspace` / `all`), `candidateLimit`, `topK`,
    `minScore`, `rerankMinScore`, `maxContextChars`, `timeoutMs`, `dedupeTurns`,
    `dedupeStateRetentionDays`, `dedupeStateMaxSessions`. A short help
    paragraph below the rows explains the special values: `minMessageLength`
    below-threshold messages skip recall and are not stored (`0` disables),
    `dedupeTurns` of `0` disables turn dedupe, `-1` allows each candidate
    (pair or memory) only once per session, successful memory writes count as
    a recall, and retention values of `0` disable that limit.
  - **Indexing** — `enabled`, `pollIntervalMs`, `retryDelayMs`, `maxAttempts`.
- **Advanced JSON** — a collapsible section with an editable JSON view of the
  whole config for fields not exposed in the structured form. Editing either
  view updates the same object; Save sends a single `config.save` patch.
- **Actions** — Save, Reload, Test embedding, and Test rerank. A small
  **Unsaved changes** marker appears next to the buttons (and as a dot on the
  Configuration tab) while the edited JSON differs from the last loaded or
  saved snapshot.

The field names and defaults match [configuration.md](configuration.md).

### Logs

The Logs tab is the diagnostic view of the plugin's own logger. It shows the
in-memory log window — entries oldest to newest in a scrollable list, each with
a timestamp (rendered in the browser's local time), a level (`debug` / `info` /
`warn` / `error`), and a message — plus the controls that shape it:

- **N input + Apply** — sets `logging.bufferSize` (integer `1..5000`, default
  `200`). Applying takes effect immediately (the buffer is trimmed to the new
  window) and persists the value to `config.json`; no separate **Save** step is
  needed.
- **Enable debug** checkbox — toggles `logging.debug` (default `false`).
  Enabling it starts collecting and forwarding debug-level entries; disabling
  it stops that immediately. The value is saved to `config.json`.
- **Refresh** — re-reads the current window from the host.
- **Write to disk** — runs the `logs.export` action, which writes the current
  window to a new file under `<home>/logs/` and shows the resulting file path
  after a successful export (see [operations.md](operations.md)).

The tab **auto-refreshes every 2 seconds while it is active** and stops when
you leave it. Logs are memory-only by default: nothing is written to disk
automatically, and the window is lost on plugin restart.

Log entries never contain user or assistant message bodies, memory content,
query text, or API keys — only ids, counts, timings, scope/name, and error
messages (see [security-and-privacy.md](security-and-privacy.md)).

## Actions

The page invokes the host API with one of these `action` values:

| Action | Purpose | Where |
| --- | --- | --- |
| `status` | Read the current runtime status (config summary, index health). | Status strip / Refresh |
| `config.save` | Persist the current form values to `config.json`. | Configuration |
| `connection.testEmbedding` | Issue a test embedding request to the configured embedding endpoint. | Configuration |
| `connection.testRerank` | Issue a test request to the configured rerank endpoint. | Configuration |
| `index.rebuild` | Rebuild the SQLite index from the JSONL pair log. | Dashboard |
| `index.clear` | Clear the index rows (outbox and index) but keep the JSONL log. | Dashboard |
| `logs.get` | Read the current in-memory log window (`{limit, debug, entries}`). | Logs |
| `logs.configure` | Persist and apply logging settings (`{bufferSize?, debug?}`). | Logs |
| `logs.export` | Write the current window to a new file under `logs/`; returns `{path, count}`. | Logs |
| `browse.scopes` | List every browse scope with per-scope source counts (`{memories, pairs}` per scope) and the malformed-JSONL-line count. | Browse (list load) |
| `browse.list` | List source entries of one kind (`memories` / `pairs`) in a scope, paged (`{kind, scope, offset, limit}`; page size 20, `limit` 1..100); items carry a status and a 200-char pair preview. | Browse (list / Load more) |
| `browse.get` | Read one entry fresh: full text (capped at 200,000 chars per field with a `*Truncated` flag), metadata, index status, and outbox state. `NOT_FOUND` (404) when the source no longer exists. | Browse (detail) |
| `browse.check` | Full index-consistency audit of one scope: status counts, mismatched entries (capped at 500 with a `truncated` flag), orphans, and malformed JSONL lines. | Browse (Check index) |
| `browse.reindex` | Synchronously re-embed one entry via the configured embedding endpoint; returns the updated model/dim/indexed-at and status. `EMBEDDING_DISABLED` (409) without an embedding model; `EMBEDDING_FAILED` (500, `{queued: true}`) leaves the entry in the outbox; `TEXT_CHANGED` (409) on a concurrent text change (CAS). | Browse (Re-index) |
| `browse.forget` | Forget a memory: renames `<name>.md` to `<name>.forgotten` (exact name + description match), rebuilds `MEMORY.md`, deletes the index row and recall-state entries. `FORGOTTEN_CONFLICT` (409) if a `.forgotten` file already exists; `NOT_FOUND` (404) on no match. | Browse (Forget, two-click confirm) |

`index.rebuild` and `index.clear` run through the same API request and return
updated status; the page reloads the status after they complete (see
[operations.md](operations.md)). A busy indicator and the result banner are
rendered at page level, below the tabs, so feedback stays visible after
switching tabs. The `browse.*` actions are read-only except `browse.reindex`
(a single embedding request for one entry) and `browse.forget` (a file rename
plus index/recall-state cleanup) — see
[security-and-privacy.md](security-and-privacy.md) and
[operations.md](operations.md#index-consistency-check-and-repair).

## API keys: password inputs

API keys are rendered as **password inputs**. Because keys are never returned
to the browser (see below), the page cannot show the stored value back. Instead:

- A **masked preview** indicates that a key is already set (for example, a
  stored/locked state), without revealing its content.
- An **empty value saves nothing** — leaving the field blank keeps the existing
  key untouched on `config.save`.
- A **clear** control is provided to explicitly remove the stored key; clearing
  and saving deletes it from `config.json`.

This distinction (blank = keep, explicit clear = remove) is important: you
cannot "unset" a key merely by emptying the field.

### Why keys are never returned

The config page is a web client. To avoid ever sending credentials to the
browser, the host API redacts API keys on read. The page only learns whether a
key *is set*, not what it is. This is enforced at the API boundary (see
[security-and-privacy.md](security-and-privacy.md)).

## Save, Reload, and Test buttons

- **Save** — runs `config.save` and persists the structured form plus any
  manual edits in the Advanced JSON view.
- **Reload** — re-reads the current saved config and resets both views to it
  (discarding unsaved edits). The status strip's **Refresh** button does the
  same and also refreshes the runtime status.
- **Test** — runs `connection.testEmbedding` and/or `connection.testRerank`
  against the **saved** config, so save the form first when validating a new
  endpoint.

## Tab accessibility

The tab bar implements the standard tab pattern:

- `role="tablist"` with `role="tab"` buttons and a `role="tabpanel"` body;
- `aria-selected`, `aria-controls`, and `aria-labelledby` link tabs to panels;
- roving `tabindex`, with `ArrowLeft` / `ArrowRight` moving between tabs and
  `Home` / `End` jumping to the first or last tab;
- the unsaved dot is decorative for sighted users, and the tab's accessible
  label appends "Unsaved changes" when the configuration is dirty.

The Browse tab follows the same conventions: the mode switch is a
`role="group"` of toggle buttons (`aria-pressed`), the entry list is a
`role="list"` inside a `role="region"` labelled list panel, rows are
focusable buttons with `aria-current` for the selected row, the detail panel
is its own labelled `role="region"`, and the check summary is announced via
`role="status"` / `aria-live`.

## Bilingual UI (EN / ZH)

All user-visible strings on the page go through translation keys. English
(`locale/en.json`) and Simplified Chinese (`locale/zh.json`) resources are
provided, and the page follows the active DSH locale. Labels are not hard-coded
in the client. The plugin title and description are `Context RAG` / `上下文 RAG`
respectively. Tab labels, the status strip, index-maintenance text, the Browse
copy (mode/scope labels, status pills, check summary, re-index and forget
controls, truncation notes), the Logs copy (log list, N input, debug toggle,
export button, and result messages), and the unsaved marker all have their own
keys in both locales.

## Theme tokens

The page is styled with DSH theme tokens rather than hard-coded colors, so it
matches the active theme (light/dark and any custom palettes) automatically.
Components use the theme's background, text, accent, border, and focus tokens
provided by the harness. The Browse status pills map states onto the theme's
semantic state tokens: `consistent` uses the success token, `missing` /
`corrupt` the error token, `stale-text` / `model-mismatch` the warn token, and
`pending` / `unknown` / `orphan` the neutral border/secondary tokens.

## Icons

No SVG icon is shipped in this cycle, per user request. The plugin row and page
render with the default harness presentation until an icon is added in a later
cycle.
