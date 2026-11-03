/**
 * Turn capture for `dsh-context-rag`.
 *
 * The capture surface listens to DSH session events and, when an agent turn
 * is about to close, writes the (user message, final assistant reply) pair
 * to the JSONL store and mirrors it into the index database. Delegated
 * ("subagent") sessions are ignored so worker agents never pollute the
 * human-facing pair store.
 *
 * @module capture
 */

import { appendPair } from "./pairs.js";
import { pairId, pairFilePath } from "./paths.js";
import { extractText } from "./text.js";

/**
 * Create the capture surface.
 *
 * @param {object} options
 * @param {object} options.db - Index database handle (see `lib/db.js`); used
 *   for the dedupe check and the pair upsert.
 * @param {object} options.configStore - Config store exposing `home` and
 *   `get()`; `home` locates the JSONL pair store.
 * @param {{warn?: (message: string) => void, error?: (message: string) => void}} [options.logger]
 *   Optional logger. Failures are logged and swallowed so a capture problem
 *   can never break an agent's turn close.
 * @returns {{attach: Function, observe: Function, stopping: Function}}
 */
export function createCapture({ db, configStore, logger }) {
  /**
   * Per-session turn buffers keyed by session id. A buffer holds the events
   * of the current turn until it closes, so `stopping` can assemble the
   * complete (user, assistant) pair.
   *
   * @type {Map<string, {turn: number, users: Array<{messageId: string, text: string}>, assistant: {messageId: string, text: string, interrupted: boolean}|null, assistantAt: number|null}>}
   */
  const buffers = new Map();

  /**
   * Record one session event into the session's buffer.
   *
   * Handles `turn/start` (reset the buffer), `user/message` (append human
   * messages only), `assistant/message` (keep the latest assistant reply and
   * whether it was interrupted), and `turn/end` (drop the buffer).
   *
   * @param {object} session - Session object with `id` and `header`.
   * @param {object} event - One DSH session event.
   * @returns {void}
   */
  function observe(session, event) {
    if (session?.header?.origin === "subagent") {
      return;
    }
    const sessionId = session?.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return;
    }
    const data = event?.data;
    switch (event?.type) {
      case "turn/start": {
        if (Number.isInteger(data?.turn) && data.turn >= 0) {
          buffers.set(sessionId, {
            turn: data.turn,
            users: [],
            assistant: null,
            assistantAt: null,
          });
        }
        break;
      }
      case "user/message": {
        if (data?.source?.kind !== "user") {
          break;
        }
        const buffer = buffers.get(sessionId);
        if (!buffer) {
          break;
        }
        const text = extractText(data.content);
        if (typeof data.id === "string" && data.id.length > 0 && text.length > 0) {
          buffer.users.push({ messageId: data.id, text });
        }
        break;
      }
      case "assistant/message": {
        const buffer = buffers.get(sessionId);
        if (!buffer || !data?.message || typeof data.message.id !== "string") {
          break;
        }
        buffer.assistant = {
          messageId: data.message.id,
          text: extractText(data.message.content),
          interrupted: data.interrupted === true,
        };
        if (Number.isFinite(data.time)) {
          buffer.assistantAt = data.time;
        }
        break;
      }
      case "turn/end":
        buffers.delete(sessionId);
        break;
      default:
        break;
    }
  }

  /**
   * Handle an `agent/turn-stopping` notification: persist the pair for the
   * just-finished turn.
   *
   * The turn is skipped when the buffer does not match `turn`, there is no
   * human message text, the assistant reply is empty, or the reply was
   * interrupted. Persisting is deduplicated against the index database so a
   * repeated notification cannot append a second line. Never throws: on
   * failure the error is logged and the turn close is unaffected.
   *
   * @param {object} agent - Agent with `session.id` and `session.header`.
   * @param {number} turn - Turn number about to close.
   * @returns {Promise<void>}
   */
  async function stopping(agent, turn) {
    const sessionId = agent?.session?.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return;
    }
    const buffer = buffers.get(sessionId);
    if (!buffer || buffer.turn !== turn) {
      return;
    }
    const userText = buffer.users.map((user) => user.text).join("\n\n");
    if (userText.length === 0) {
      return;
    }
    if (!buffer.assistant || buffer.assistant.text.length === 0) {
      return;
    }
    if (buffer.assistant.interrupted === true) {
      return;
    }

    const id = pairId({
      sessionId,
      turn,
      userMessageIds: buffer.users.map((user) => user.messageId),
      assistantMessageId: buffer.assistant.messageId,
    });
    const cwd = typeof agent.session.header?.cwd === "string" ? agent.session.header.cwd : "";
    const createdAt = buffer.assistantAt ?? Date.now();
    const record = {
      pairId: id,
      sessionId,
      cwd,
      turn,
      createdAt,
      user: userText,
      assistant: buffer.assistant.text,
    };

    try {
      if (db.getPair(id)) {
        return; // Already indexed; do not duplicate the pair line.
      }
      const file = pairFilePath({ home: configStore.home, cwd, sessionId });
      await appendPair(file, record);
      db.upsertPair(record);
    } catch (err) {
      logger?.warn?.(`[context-rag] capture failed to store pair ${id}: ${String(err?.message ?? err)}`);
    }
  }

  /**
   * Register the capture event handlers on the host context.
   *
   * @param {object} ctx - Host plugin context with `on` (and optionally
   *   `off`) event registration.
   * @returns {Function} Disposer that unregisters the handlers (via `off` or
   *   the per-registration disposers returned by `on`) and drops all buffers.
   *   Safe to call more than once.
   */
  function attach(ctx) {
    const handlers = [
      ["session/event", (session, event) => observe(session, event)],
      ["agent/turn-stopping", async ({ agent, turn }) => {
        await stopping(agent, turn);
      }],
      ["session/disposed", (session) => buffers.delete(session?.id)],
    ];
    const disposers = [];
    for (const [type, handler] of handlers) {
      const result = ctx.on(type, handler);
      if (typeof result === "function") {
        disposers.push(result);
      }
    }
    let disposed = false;
    return () => {
      if (disposed) {
        return;
      }
      disposed = true;
      if (typeof ctx.off === "function") {
        for (const [type, handler] of handlers) {
          ctx.off(type, handler);
        }
      }
      for (const disposer of disposers) {
        disposer();
      }
      buffers.clear();
    };
  }

  return { attach, observe, stopping };
}
