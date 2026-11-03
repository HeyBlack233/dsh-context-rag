/**
 * Context message construction for `dsh-context-rag`.
 *
 * Builds the read-only user message that carries injected retrieval context
 * into a session. The message is frozen so downstream middleware cannot mutate
 * the injected payload, and its `source` identifies it as plugin-generated
 * reference material rather than a genuine user instruction.
 *
 * @module message
 */

import { randomUUID } from "node:crypto";
import { boundSummary } from "./text.js";

/**
 * Create a frozen plain user message that holds injected RAG context.
 *
 * @param {object} options
 * @param {string} options.text - The rendered injection body.
 * @param {string} options.summary - A short human-readable summary.
 * @returns {object} A frozen user message with `source.kind === "context-rag"`
 *   and `source.form === "notice"`.
 */
export function createContextMessage({ text, summary }) {
  return Object.freeze({
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: {
      kind: "context-rag",
      form: "notice",
      summary: boundSummary(summary),
    },
  });
}
