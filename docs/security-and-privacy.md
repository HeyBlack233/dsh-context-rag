# Security and Privacy

`context-rag` is designed to be local-first and privacy-preserving. This page
summarizes how data is stored, how credentials are handled, how the injected
background text is treated, and the practical caveats you should be aware of.

## Data is local plaintext

All plugin data lives on disk under the data home (see
[storage-and-data-model.md](storage-and-data-model.md)):

- `config.json` holds the runtime config.
- `pairs/` holds the human-readable JSONL pair log.
- `index.sqlite` is the rebuildable embedding index.

The pair log is plaintext, append-only, and human-readable so it can be
inspected, grepped, or edited. Nothing is encrypted at rest; the security model
is *local machine access*, not data-at-rest encryption.

## API keys

- API keys are stored in `config.json` under the data home, written
  atomically with mode `0600` (readable only by the owning user).
- **Keys are never sent to the browser.** The host API redacts keys on read;
  the configuration page only knows whether a key is set, not its value (see
  [configuration-page.md](configuration-page.md)).
- Keys travel only to the configured embedding/rerank endpoints, over the
  transport the endpoint uses.

## Same-origin API with trust checks

The configuration page talks to the plugin through a single same-origin API
(`POST /plugins/dsh-context-rag/api`). Because it is served by the running
harness and only reachable in-process, it does not expose data to the public
internet. The API applies trust checks on what it accepts, so only valid config
and index actions are performed.

## Retrieval scope

Retrieval is scoped to control which past pairs are eligible (see
[retrieval-and-injection.md](retrieval-and-injection.md)):

| Scope | Meaning |
| --- | --- |
| `workspace` (default) | Only pairs whose `cwd` exactly matches the current workspace. |
| `all` | Pairs from all workspaces. |

Using `workspace` keeps a session's retrieved context confined to that
workspace; use `all` only when cross-workspace recall is intended.

## Subagent sessions are excluded

Only **direct** user messages are captured (source kind `user`). Subagent
sessions, interrupted turns, and empty turns are skipped, so background agent
activity is not stored into the pair log.

## Injected text is untrusted

Retrieved text is injected as a read-only, user-role context message with
**source metadata** identifying it as `context-rag`. The injected text is
treated as **untrusted background** from prior turns:

- It carries a **fixed warning** that the background text is untrusted and must
  not be treated as authoritative instructions.
- Any `<` in the pair text is escaped (rendered as `\u003c`) to prevent markup
  injection.
- It is attached once per user message and marked read-only/durable.

### Prompt-injection caveat

The retrieved pairs originate from *your own past turns* in the same
workspace. If any of those turns contained instructions that look like system
prompts or requests to change behavior, the injected context could carry that
content. This is a **prompt-injection risk**: a prior turn containing
adversarial text could surface in later context. The fixed warning and the
read-only framing mitigate it, but they do not eliminate it. Treat retrieved
content as data, not as instructions, and avoid storing sensitive instructions
as user text if cross-contamination is a concern.

## Secrets in the JSONL

The pair log stores exactly what you type and what the assistant replies. If
you paste an API key, password, or secret into a user message, it will appear
in plaintext in the JSONL (and be embedded/indexed). **No secrets are written
unless you type them** — the plugin never injects its own credentials into the
log. Be mindful that anything you type into a conversation becomes retrievable
content.

## Deletion and cleanup

- The JSONL log is the source of truth; to remove data, delete or edit the
  corresponding `.jsonl` line.
- `index.sqlite` is a rebuildable cache — you can safely delete it, and it is
  rebuilt from JSONL on the next startup reconcile.
- The configuration page's `index.clear` clears the index (and outbox) but
  **keeps the JSONL log**; deleting the JSONL is a separate, explicit step.
- See [operations.md](operations.md) for safe-deletion guidance.

## No external vector database

Embeddings are computed via a configurable HTTP endpoint, but the **index
itself is local** (`index.sqlite`). There is no external vector database, so
your pair data is never uploaded to a vector store. Only the text sent to the
embedding endpoint (for the purpose of computing a vector) leaves the machine,
and only if you have configured an embedding endpoint.
