# Configuration Page

`context-rag` is configured through a dedicated page in the Harness GUI. This
page describes how that page is wired up, what sections it shows, what actions
it exposes, and how API keys are handled. For the underlying config fields and
their defaults, see [configuration.md](configuration.md).

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

## Sections

The page is split into the following sections:

- **Status** — pair/index/pending/error counts, data home, embedding model
  and dimension, indexer running state, and the last/init errors.
- **Settings** — a structured, responsive form for the common fields:
  - embedding `enabled`, `baseUrl`, `model`, `dimensions`, `apiKey`,
    `timeoutMs`, `maxRetries`, `batchSize`, `maxEmbeddingChars`;
  - rerank `enabled`, `baseUrl`, `model`, `path`, `apiKey`;
  - retrieval `injectionEnabled`, `scope` (`workspace` / `all`),
    `candidateLimit`, `topK`, `minScore`, `maxContextChars`, `timeoutMs`;
  - indexing `enabled`, `pollIntervalMs`, `retryDelayMs`, `maxAttempts`.
- **Advanced JSON** — an editable JSON view of the whole config for fields
  not exposed in the structured form. Editing either view updates the same
  object; Save sends a single `config.save` patch.
- **Actions** — Save, Reload, Test embedding, Test rerank, Rebuild index, and
  Clear index. Rebuild/Clear use a two-click confirmation and the page polls
  status while work is pending.

The field names and defaults match [configuration.md](configuration.md).

## Actions

The page invokes the host API with one of these `action` values:

| Action | Purpose |
| --- | --- |
| `status` | Read the current runtime status (config summary, index health). |
| `config.save` | Persist the current form values to `config.json`. |
| `connection.testEmbedding` | Issue a test embedding request to the configured embedding endpoint. |
| `connection.testRerank` | Issue a test request to the configured rerank endpoint. |
| `index.rebuild` | Rebuild the SQLite index from the JSONL pair log. |
| `index.clear` | Clear the index rows (outbox and index) but keep the JSONL log. |

`index.rebuild` and `index.clear` run asynchronously; the page polls the index
status until the operation reports completion (see
[operations.md](operations.md)).

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
  (discarding unsaved edits).
- **Test** — runs `connection.testEmbedding` and/or `connection.testRerank`
  against the **saved** config, so save the form first when validating a new
  endpoint.

## Bilingual UI (EN / ZH)

All user-visible strings on the page go through translation keys. English
(`locale/en.json`) and Simplified Chinese (`locale/zh.json`) resources are
provided, and the page follows the active DSH locale. Labels are not hard-coded
in the client. The plugin title and description are `Context RAG` / `上下文 RAG`
respectively.

## Theme tokens

The page is styled with DSH theme tokens rather than hard-coded colors, so it
matches the active theme (light/dark and any custom palettes) automatically.
Components use the theme's background, text, accent, border, and focus tokens
provided by the harness.

## Icons

No SVG icon is shipped in this cycle, per user request. The plugin row and page
render with the default harness presentation until an icon is added in a later
cycle.
