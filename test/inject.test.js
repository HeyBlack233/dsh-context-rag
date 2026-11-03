import test from "node:test";
import assert from "node:assert/strict";
import { createInjector } from "../lib/inject.js";

function makeCtx() {
  const handlers = [];
  return {
    on(event, fn, opts) {
      assert.equal(event, "agent/pre-step");
      assert.equal(opts.prepend, true);
      handlers.push(fn);
      return () => {
        /* disposer */
      };
    },
    handlers,
  };
}

function makeSession(overrides = {}) {
  return {
    id: "s1",
    header: { origin: "agent", cwd: "/proj", ...(overrides.header || {}) },
    ...overrides,
  };
}

function makeUserMessage(text, id) {
  return { id, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] };
}

function makeDecision(messages) {
  return { kind: "normal", messages };
}

function makeInjector({ retriever, config }) {
  const ctx = makeCtx();
  const injector = createInjector({
    retriever,
    configStore: { get: () => config },
    logger: { warn() {}, error() {} },
  });
  const disposer = injector.attach(ctx);
  return { ctx, injector, disposer, handler: ctx.handlers[0] };
}

function makeDefaultRetriever(calls = []) {
  return {
    async retrieve({ query, cwd, signal }) {
      calls.push({ query, cwd, signal });
      return {
        pairs: [
          {
            userText: "q1",
            assistantText: "a1",
            createdAt: new Date(),
            cwd,
            score: 0.9,
          },
        ],
      };
    },
  };
}

test("appends one context-rag notice message for a new direct user message", async () => {
  const calls = [];
  const { handler, disposer, injector } = makeInjector({
    retriever: makeDefaultRetriever(calls),
    config: { retrieval: { maxContextChars: 8000 } },
  });
  assert.equal(typeof disposer, "function");

  const message = makeUserMessage("hello", "m1");
  const session = makeSession();
  const decision = makeDecision([message]);
  const payload = { agent: { session }, signal: { aborted: false } };

  const result = await handler(payload, async () => decision);
  assert.equal(result.kind, "normal");
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0], message);

  const added = result.messages[1];
  assert.equal(added.role, "user");
  assert.equal(added.source.kind, "context-rag");
  assert.equal(added.source.form, "notice");
  assert.ok(added.source.summary.length <= 120);
  assert.equal(added.content[0].type, "text");
  assert.ok(added.content[0].text.includes("Context RAG:"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query, "hello");
  assert.equal(calls[0].cwd, "/proj");
  assert.equal(injector.status().lastError, null);
});

test("does not re-inject for the same message across repeated pre-steps", async () => {
  const calls = [];
  const { handler } = makeInjector({
    retriever: makeDefaultRetriever(calls),
    config: { retrieval: { maxContextChars: 8000 } },
  });
  const message = makeUserMessage("hello", "m1");
  const session = makeSession();
  const decision = makeDecision([message]);
  const payload = { agent: { session }, signal: { aborted: false } };

  const first = await handler(payload, async () => decision);
  assert.equal(first.messages.length, 2);
  const second = await handler(payload, async () => decision);
  assert.equal(second.messages.length, 1);
  assert.equal(calls.length, 1);
});

test("skips synthetic (non-user-source) messages", async () => {
  const calls = [];
  const { handler } = makeInjector({
    retriever: makeDefaultRetriever(calls),
    config: { retrieval: { maxContextChars: 8000 } },
  });
  const message = {
    id: "s1",
    role: "user",
    source: { kind: "tool" },
    content: [{ type: "text", text: "hi" }],
  };
  const decision = makeDecision([message]);
  const payload = { agent: { session: makeSession() }, signal: { aborted: false } };
  const result = await handler(payload, async () => decision);
  assert.equal(result.messages.length, 1);
  assert.equal(calls.length, 0);
});

test("skips subagent sessions", async () => {
  const calls = [];
  const { handler } = makeInjector({
    retriever: makeDefaultRetriever(calls),
    config: { retrieval: { maxContextChars: 8000 } },
  });
  const message = makeUserMessage("hello", "m1");
  const session = makeSession({ header: { origin: "subagent", cwd: "/sub" } });
  const decision = makeDecision([message]);
  const payload = { agent: { session }, signal: { aborted: false } };
  const result = await handler(payload, async () => decision);
  assert.equal(result.messages.length, 1);
  assert.equal(calls.length, 0);
});

test("returns the decision unchanged for a rejected decision", async () => {
  const calls = [];
  const { handler } = makeInjector({
    retriever: makeDefaultRetriever(calls),
    config: { retrieval: { maxContextChars: 8000 } },
  });
  const decision = { kind: "reject", messages: [] };
  const payload = { agent: { session: makeSession() }, signal: { aborted: false } };
  const result = await handler(payload, async () => decision);
  assert.equal(result, decision);
  assert.equal(calls.length, 0);
});

test("returns the decision unchanged when there are no pairs", async () => {
  const retriever = {
    async retrieve() {
      return { pairs: [] };
    },
  };
  const { handler } = makeInjector({
    retriever,
    config: { retrieval: { maxContextChars: 8000 } },
  });
  const message = makeUserMessage("hello", "m1");
  const decision = makeDecision([message]);
  const payload = { agent: { session: makeSession() }, signal: { aborted: false } };
  const result = await handler(payload, async () => decision);
  assert.equal(result.messages.length, 1);
});

test("recovers from a retriever error without throwing", async () => {
  const retriever = {
    async retrieve() {
      throw new Error("boom");
    },
  };
  const { handler, injector } = makeInjector({
    retriever,
    config: { retrieval: { maxContextChars: 8000 } },
  });
  const message = makeUserMessage("hello", "m1");
  const decision = makeDecision([message]);
  const payload = { agent: { session: makeSession() }, signal: { aborted: false } };
  const result = await handler(payload, async () => decision);
  assert.equal(result, decision);
  assert.equal(injector.status().lastError, "boom");
});

test("returns the decision unchanged when renderInjection cannot fit a budget", async () => {
  const retriever = makeDefaultRetriever();
  const { handler } = makeInjector({
    retriever,
    config: { retrieval: { maxContextChars: 5 } },
  });
  const message = makeUserMessage("hello", "m1");
  const decision = makeDecision([message]);
  const payload = { agent: { session: makeSession() }, signal: { aborted: false } };
  const result = await handler(payload, async () => decision);
  assert.equal(result.messages.length, 1);
});
