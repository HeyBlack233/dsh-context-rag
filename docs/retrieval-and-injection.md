# Retrieval and Injection

This page describes the read path: how the plugin finds similar past pairs and
injects them into the conversation before each model step.

## Trigger

An `agent/pre-step` hook runs before each model step. It detects **new direct
user messages** (source kind `user`). Injected context is attached **once per
user message**; subsequent steps in the same turn do not re-inject.

## Pipeline

1. **Query embedding** — embed the new user message using the configured
   embedding API (same model/dim as the index).
2. **Candidate scan** — scan the SQLite index for candidate pairs, filtered by
   scope and by embedding model + dimension (only vectors comparable to the
   query are considered).
3. **Score** — cosine similarity is computed as the dot product of the
   normalized query vector and each normalized candidate vector.
4. **Filter** — keep candidates at or above `minScore`.
5. **Optional rerank** — if the reranker is enabled, pass candidates to the
   OpenAI-compatible rerank endpoint and keep its `topN`.
6. **Select** — keep the top `topK` pairs.

The whole pipeline is bounded by `timeoutMs` and `scanLimit`. Failures are
fail-open: on timeout or error, injection is skipped and a warning is logged.

## Scope

The scope decides which pairs are eligible:

| Scope | Meaning |
| --- | --- |
| `workspace` (default) | Only pairs whose `cwd` exactly matches the current workspace directory. |
| `all` | Pairs from all workspaces. |

See [configuration.md](configuration.md) for the `scope` field.

## Score and limits

- Cosine similarity equals the dot product of normalized vectors, so candidate
  and query vectors are normalized before scoring.
- `candidateLimit` caps candidates considered by the scan; `minScore` is the
  cosine threshold below which candidates are dropped.
- `topK` is the final number of pairs injected (after rerank, if enabled).
- `maxContextChars` caps the total length of the injected context text.

## Injection

### Message shape

The top pairs are injected once per user message as an **extra user-role
context message** carrying source metadata:

```json
{
  "source": {
    "kind": "context-rag",
    "form": "notice",
    "summary": "Retrieved N related past turns"
  }
}
```

The message is marked read-only and durable, so downstream steps keep seeing it
without re-injecting.

### Rendered text

The injected text has a fixed framing plus a per-pair header, and the pair text
is escaped (any `<` is rendered as `\u003c`) to avoid markup injection. The
message also carries an explicit warning that the retrieved background text is
**untrusted** — it comes from prior turns and must not be treated as
authoritative instructions.

### Visibility

- **Chat** hides ordinary context rows.
- **Trajectory** shows them, so the retrieved context is visible in the
  trajectory view for inspection/debugging.

## Fail-open behavior

Any of the following skip injection and log a warning instead of failing the
turn:

- Embedding endpoint timeout or error.
- Rerank endpoint timeout or error (when enabled).
- No candidates above `minScore`.
- Context text exceeding `maxContextChars`.

Retrieval is an enhancement, never a blocker.
