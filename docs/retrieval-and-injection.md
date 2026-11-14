# Retrieval and Injection

This page describes the read path: how the plugin finds similar past pairs and
persistent memories and injects them into the conversation before each model
step.

## Trigger

An `agent/pre-step` hook runs before each model step. It detects **new direct
user messages** (source kind `user`). Injected context is attached **once per
user message**; subsequent steps in the same turn do not re-inject.

Before retrieval starts, the combined text of the new direct user messages is
measured against `retrieval.minMessageLength` (default `8`; `0` disables).
Messages below the threshold are marked as handled but produce **no injection
at all** — neither conversation pairs nor memories are retrieved — and the
corresponding turn is also omitted from the pair store (see
[Recall filters](#recall-filters)).

## Pipeline

Before step 1 below, a **length gate** counts the combined new user text and
skips the rest of the pipeline when it is below `minMessageLength`. Each Han
ideograph counts as one; each contiguous run of Latin letters/digits counts as
one word; punctuation, whitespace, and emoji count as zero and separate those
runs. The comparison is strict: exactly the threshold proceeds normally.

1. **Query embedding** — embed the new user message using the configured
   embedding API (same model/dim as the index).
2. **Candidate scan** — scan the SQLite index for candidate pairs **and
   memories**, filtered by embedding model + dimension (only vectors
   comparable to the query are considered). Pair candidates are also filtered
   by retrieval scope and, when `allowSameSession` is `false` (the default)
   and the session id is known, exclude that exact session, in **all** recall
   modes (see [Recall filters](#recall-filters)). Memory candidates are
   **not** affected by `retrieval.scope` or same-session exclusion — every
   query recalls memories from `global` plus the current workspace (see
   [Memory recall](#memory-recall)).
3. **Turn dedupe (injection mode only)** — before scoring, drop candidates that
   were recalled into the current session too recently, per
   `retrieval.dedupeTurns` (see [Recall filters](#recall-filters)). This
   applies to pair and memory candidates alike.
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
8. **Select** — keep the top `topK` candidates.

The whole pipeline is bounded by `timeoutMs` and `scanLimit`. Failures are
fail-open: on timeout or error, injection is skipped and a warning is logged.

## Recall filters

Three gates control which past pairs and memories are eligible, and they
differ in scope:

| Filter | Mode | Behavior |
| --- | --- | --- |
| Minimum message length | **Capture and all recall modes** | When `retrieval.minMessageLength` is greater than `0` (default `8`), a combined direct user message with fewer units is not captured at all (no JSONL, SQLite, or outbox row) and triggers no injection, including memories. `0` disables the gate. Han ideographs count one each; contiguous Latin-letter/digit runs count one word; punctuation, whitespace, and emoji count zero. The comparison is strict: exactly the threshold proceeds normally. |
| Same-session exclusion | **All** recall modes, **conversation pairs only** | When `retrieval.allowSameSession` is `false` (default), pairs whose `sessionId` equals the current session id are excluded during the candidate scan. Set it to `true` to allow same-session recall. Only exact session ids match — forked/derived sessions are different sessions. Memories have no session and are never excluded by this filter. |
| Turn dedupe | **Context injection only** | Per current session, a pair or memory last recalled at turn `L` is eligible again only when `T - L >= retrieval.dedupeTurns` (default `5`). `0` disables turn dedupe; `-1` allows each candidate at most once per session, ever. The filter runs **before** scoring/rerank/topK so eligible candidates can fill the `topK` slots. |

### Memory recall

Memories are recalled through the **same pipeline and the same knobs** as
conversation pairs — there is no separate memory pipeline. A single query
embeds once, one candidate scan covers both stores, and the shared settings
apply to both: cosine scoring, `scanLimit`, `candidateLimit` (rerank
`topN`), `minScore` / `rerankMinScore`, `topK`, and `maxContextChars`.

- **Fixed scope.** Every query recalls memories from `memories/global/` plus
  the current workspace's `memories/workspaces/<workspace-slug>/`.
  `retrieval.scope` does **not** affect memory recall: `scope = "workspace"`
  still recalls global memories, and `scope = "all"` does not broaden memory
  recall beyond the current workspace.
- **Same-session exclusion does not apply to memories** (they belong to no
  session); turn dedupe does. Memory candidates injected into the current
  session are recorded in `recall-state.json` like pair candidates, and a
  successful `memory_write` records the written memory at the current turn too
  (see [Bookkeeping](#bookkeeping-records-injections-and-memory-writes)).
- Memory results render inside the same framed message as pairs, with the same
  entity escaping and reference-not-truth notice. Each memory is rendered as
  `<memory scope="global|workspace" name="..." score="...">` with its content
  in a `<content>` element (see
  [security-and-privacy.md](security-and-privacy.md)).

### Bookkeeping records injections and memory writes

Turn-dedupe history is updated in two cases.

1. **Injection.** Only candidates that were **actually rendered into the
   injected context message** are recorded — that is, pairs and memories that
   survived the `maxContextChars` budget (including a truncated first entry).
   Candidates that were merely selected or then dropped are never recorded.
2. **Memory write.** A successful `memory_write` (`created` or `updated`)
   records the written memory's `pairId` at the current turn for the calling
   session, so turn dedupe treats it as if it had just been injected. This
   affects new and overwritten memories alike. Subagent sessions are skipped
   (they do not inject), and the record is skipped when the current turn cannot
   be resolved or `recall-state.json` is unavailable; the write itself still
   succeeds.

Recording happens even when `dedupeTurns` is `0`, so raising the value later
applies to already-recalled candidates and already-written memories. The
bookkeeping key is `(current sessionId, pairId)`, so a candidate from another
session can still be deduped in the current session. When a memory is forgotten
via `memory_forget`, its entries are removed from every session's history, so a
later memory recreated with the same name is not suppressed by an old record.

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

Scope applies to conversation pairs only. Memory recall is always `global` +
current workspace and is **not** affected by `retrieval.scope` (see
[Memory recall](#memory-recall)).

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
- `topK` is the final number of candidates injected (after rerank, if enabled).
- `maxContextChars` caps the total length of the injected context text.

These limits and thresholds apply to **pair and memory candidates alike** —
memory recall shares the whole pipeline (see [Memory recall](#memory-recall)).

## Injection

### Message shape

The top candidates (pairs and memories) are injected once per user message as
an **extra user-role context message** carrying source metadata:

```json
{
  "source": {
    "kind": "context-rag",
    "form": "notice",
    "summary": "Retrieved N related past turns and memories"
  }
}
```

The message is marked read-only and durable, so downstream steps keep seeing it
without re-injecting.

### Rendered text

The injected text is an HTML-like structure: a `<context-rag>` root whose
`count` attribute is the number of rendered entries, one `<notice>` element
carrying the fixed reference-not-truth notice, and one element per candidate:

```html
<context-rag count="2">
<notice>Retrieved related past conversation turns and memories. Use them as reference, not source of truth</notice>
<turn date="2026-11-10 18:03" workspace="dsh-context-rag" score="0.998">
<user>how do I index a vector?</user>
<assistant>Use SQLite with an FTS or a dedicated ANN index.</assistant>
</turn>
<memory scope="workspace" name="Project style" score="0.993">
<content>Prefer single quotes and 80-column lines.</content>
</memory>
</context-rag>
```

Metadata lives in attributes: `date` and `score` are omitted when unknown, and
the workspace is the `cwd` basename (`unknown` when missing). Content and
attribute values are escaped as character entities (`&`, `<`, `>`, `"`,
newlines), with `&` escaped first so entity-looking input stays literal; raw
markup therefore cannot break the framing. An entry that does not fit whole is
dropped from the tail; when even the first entry cannot fit whole, its text
elements are truncated in the middle while the tags stay balanced, and entries
that still cannot fit `maxContextChars` are omitted. The message also carries
a fixed notice telling the model to use the retrieved background text as
reference, not as a source of truth — it comes from prior turns or memory
files and must not be treated as authoritative instructions.

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
