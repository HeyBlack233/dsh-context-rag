/**
 * Injection middleware for `dsh-context-rag`.
 *
 * `createInjector` attaches a `agent/pre-step` handler that appends one
 * read-only context message carrying retrieved past turns to each new direct
 * user message, deduplicating across repeated pre-steps and skipping
 * synthetic messages, subagents, and rejected decisions.
 *
 * @module inject
 */

import { createContextMessage } from "./message.js";
import { renderInjection } from "./render.js";
import { extractText } from "./text.js";

/** Cap on tracked message ids per session before pruning oldest entries. */
const MAX_HANDLED = 200;

/**
 * Create an injector.
 *
 * @param {object} deps
 * @param {object} deps.retriever - Retriever exposing `retrieve({query,cwd,signal})`.
 * @param {{get:Function}} deps.configStore - Config store exposing `.get()`.
 * @param {object} [deps.logger] - Logger with `warn`.
 * @returns {{attach:Function, status:Function}} The injector.
 */
export function createInjector({ retriever, configStore, logger = console }) {
  let lastError = null;
  /** @type {Map<string,Set<string>>} Per-session handled message ids. */
  const handled = new Map();

  /**
   * @returns {{lastError:string|null}} Status snapshot.
   */
  function status() {
    return { lastError };
  }

  /**
   * Attach the pre-step handler to a context.
   *
   * @param {object} ctx - A Cordis context supporting `ctx.on`.
   * @returns {Function|undefined} The disposer returned by `ctx.on`, if any.
   */
  function attach(ctx) {
    const handle = async (payload, next) => {
      const decision = await next();
      if (
        !decision ||
        decision.kind === "reject" ||
        payload.signal?.aborted
      ) {
        return decision;
      }
      if (payload.agent?.session?.header?.origin === "subagent") {
        return decision;
      }

      const sessionId = payload.agent?.session?.id ?? "";
      let seen = handled.get(sessionId);
      if (!seen) {
        seen = new Set();
        handled.set(sessionId, seen);
      }

      const newUserMessages = (decision.messages ?? []).filter(
        (message) =>
          message?.role === "user" &&
          message?.source?.kind === "user" &&
          message?.id != null &&
          !seen.has(message.id),
      );

      // Mark immediately so repeated pre-steps do not re-inject.
      for (const message of newUserMessages) {
        seen.add(message.id);
      }

      if (newUserMessages.length === 0) {
        return decision;
      }

      // Prune oldest entries when the set grows past the cap.
      if (seen.size > MAX_HANDLED) {
        let excess = seen.size - MAX_HANDLED;
        for (const id of seen) {
          if (excess <= 0) break;
          seen.delete(id);
          excess -= 1;
        }
      }

      const query = newUserMessages
        .map((message) => extractText(message.content))
        .filter(Boolean)
        .join("\n");
      const cwd = payload.agent?.session?.header?.cwd ?? "";

      try {
        const result = await retriever.retrieve({
          query,
          cwd,
          signal: payload.signal,
        });
        if (!result.pairs || result.pairs.length === 0) {
          return decision;
        }
        const rendered = renderInjection({
          pairs: result.pairs,
          maxChars: configStore.get().retrieval?.maxContextChars ?? 8000,
        });
        if (!rendered) {
          return decision;
        }
        const message = createContextMessage({
          text: rendered.text,
          summary: rendered.summary,
        });
        return {
          ...decision,
          messages: [...(decision.messages ?? []), message],
        };
      } catch (err) {
        lastError = err.message;
        logger.warn?.(`[context-rag] injection failed: ${err.message}`);
        return decision;
      }
    };

    return ctx.on("agent/pre-step", handle, { prepend: true });
  }

  return { attach, status };
}
