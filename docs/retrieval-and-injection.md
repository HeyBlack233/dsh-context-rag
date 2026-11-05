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
   query are considered). When `allowSameSession` is `false` (the default) and
   the session id is known, pairs from that exact session are excluded here, in
   **all** recall modes (see [Recall filters](#recall-filters)).
3. **Turn dedupe (injection mode only)** — before scoring, drop candidates that
   were injected into the current session too recently, per
   `retrieval.dedupeTurns` (see [Recall filters](#recall-filters)).
4. **Score** — cosine similarity is computed as the dot product of the
   normalized query vector and each normalized candidate vector.
5. **Cosine filter** — keep candidates whose cosine similarity is at or above
   `minScore`.
6. **Optional rerank** — if the reranker is enabled, pass candidates to the
   OpenAI-compatible rerank endpoint and replace each candidate's score with
   the reranker's relevance score.
7. **Rerank filter** — when rerank is enabled, drop candidates whose rerank
   relevance score is below `rerankMinScore`. This is a separate threshold
   because cosine similarity and rerank relevance are different scales.
8. **Select** — keep the top `topK` pairs.

The whole pipeline is bounded by `timeoutMs` and `scanLimit`. Failures are
fail-open: on timeout or error, injection is skipped and a warning is logged.

## Recall filters

Two filters control which past pairs are eligible, and they differ in scope:

| Filter | Mode | Behavior |
| --- | --- | --- |
| Same-session exclusion | **All** recall modes | When `retrieval.allowSameSession` is `false` (default), pairs whose `sessionId` equals the current session id are excluded during the candidate scan. Set it to `true` to allow same-session recall. Only exact session ids match — forked/derived sessions are different sessions. |
| Turn dedupe | **Context injection only** | Per current session, a pair previously injected at turn `L` is eligible again only when `T - L >= retrieval.dedupeTurns` (default `5`). `0` disables turn dedupe; `-1` allows each pair at most once per session, ever. The filter runs **before** scoring/rerank/topK so eligible pairs can fill the `topK` slots. |

### Bookkeeping records only what is actually injected

Turn-dedupe history is updated only for pairs that were **actually rendered
into the injected context message** — that is, pairs that survived the
`maxContextChars` budget (including a truncated first entry). Pairs that were
merely selected or then dropped are never recorded. Recording happens even when
`dedupeTurns` is `0`, so raising the value later applies to already-recalled
pairs. The bookkeeping key is `(current sessionId, pairId)`, so a pair from
another session can still be deduped in the current session.

### Recall state is separate and fail-open

The bookkeeping lives in `recall-state.json` under the data home, independent
of `index.sqlite` (see
[storage-and-data-model.md](storage-and-data-model.md)). If the recall-state
file is missing, corrupt, or unwritable, the store warns, starts/continues
empty, and the pipeline proceeds: turn dedupe simply does not run or record.
Recording can never prevent injection.

### Observability is stats-only

The per-call retrieval `stats` include `candidateCount` (candidates returned by
the index scan after same-session exclusion, before turn dedupe),
`excludedSameSession` (same-session pairs matching the candidate filters,
counted by a separate query), `excludedDedupe` (candidates excluded by turn
dedupe), and `dedupeApplied` (whether the turn-dedupe filter ran).
`lastRetrieval` — and therefore the API status — carries the three exclusion
fields (`excludedSameSession`, `excludedDedupe`, `dedupeApplied`) in addition
to its existing fields. These numbers are reported in stats/status only —
**no filter or stat information ever enters the injected context text**, and
the rendered message carries no dedupe metadata.

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
  cosine threshold below which candidates are dropped before reranking.
- `rerankMinScore` is the threshold for the reranker's relevance scores. It
  only applies when rerank is enabled, and the injected `score` is the score
  that passed it, so it is never below `rerankMinScore`.
- Both thresholds accept values from `0.00` to `1.00` with two decimals.
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
