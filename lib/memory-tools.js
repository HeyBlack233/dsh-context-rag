/**
 * Agent tools for managing persistent memories.
 *
 * Registers `memory_list`, `memory_get`, `memory_write`, and `memory_forget`
 * through the host's tool registry. Every tool reads the working directory
 * from `exec.agent.session.header.cwd` — callers can never pass one — and a
 * tool called without an agent fails with a clear error. The tools talk to the
 * memory store (`createMemoryStore` from `./memories.js`) and keep the SQLite
 * index in sync (`db.upsertMemory` / `db.deletePair` plus `indexer.wake`).
 *
 * Definitions are built with `defineTool` from `@deepseek-ai/dsh-tools`, which
 * the DSH runtime resolves for linked plugins (the package is declared as a
 * `peerDependency` in `package.json`). Tool errors are thrown as plain
 * `Error`s so the host surfaces them to the agent; no memory content is ever
 * logged.
 *
 * @module memory-tools
 */

import { defineTool } from "@deepseek-ai/dsh-tools";

// ---------------------------------------------------------------------------
// Shared execute helpers
// ---------------------------------------------------------------------------

/**
 * Require an agent session, so the tool's working directory is well-defined.
 *
 * @param {object} exec - Tool execution context (`{agent, signal}`).
 * @param {string} toolName - Tool name for the error message.
 * @returns {object} The calling agent.
 * @throws {Error} When no agent is present.
 */
function requireAgent(exec, toolName) {
  if (exec == null || exec.agent == null) {
    throw new Error(`${toolName} requires an agent Session (the working directory cannot be resolved without one)`);
  }
  return exec.agent;
}

/**
 * Resolve the calling session's working directory. Never accepts a caller-
 * supplied path: the workspace is always `exec.agent.session.header.cwd`.
 *
 * @param {object} agent - The calling agent.
 * @param {string} toolName - Tool name for the error message.
 * @returns {string} Absolute workspace directory.
 * @throws {Error} When the session has no working directory.
 */
function resolveCwd(agent, toolName) {
  const cwd = agent.session?.header?.cwd;
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error(`${toolName} requires a workspace: the session has no working directory (agent.session.header.cwd)`);
  }
  return cwd;
}

/** The supported memory scopes, shared by every tool schema. */
const MEMORY_SCOPE_ENUM = ["global", "workspace"];

/**
 * Scope parameter shared by the four tools: the memory directory to operate
 * on. `workspace` resolves against the current session's working directory.
 */
function scopeParameter(extra = "") {
  return {
    type: {
      type: "string",
      enum: MEMORY_SCOPE_ENUM,
      required: true,
      description: `Which memory directory to operate on: \`global\` for memories available from every workspace, \`workspace\` for memories scoped to the current session's working directory.${extra}`,
    },
  };
}

/** Scope suffix used in rendered text. */
function scopeLabel(type) {
  return type === "global" ? "global" : "workspace";
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/**
 * Build the four memory tool definitions bound to the given dependencies.
 *
 * @param {object} deps
 * @param {object} deps.memoryStore - Memory store from `createMemoryStore`.
 * @param {object|null} deps.db - Index database (may be null).
 * @param {object|null} deps.indexer - Background indexer (may be null).
 * @param {object|null} [deps.configStore] - Config store (reserved).
 * @returns {Array<object>} Registry-ready tool definitions.
 */
function createMemoryToolDefinitions({ memoryStore, db, indexer }) {
  return [
    defineTool({
      name: "memory_list",
      description:
        "List the names and one-line descriptions of saved memories in a memory directory. " +
        "Call this on the target directory before memory_write to check whether a memory on the same topic already exists, " +
        "and before memory_get or memory_forget to obtain the exact name and description of a memory. " +
        "The working directory is taken from the current session automatically; it cannot be passed as an argument.",
      parameters: scopeParameter(),
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: {
              type: "string",
              required: true,
              description: "The memory directory that was listed (global or workspace).",
            },
            cwd: {
              type: "string",
              description: "The workspace directory, present only when type is `workspace`.",
            },
            count: {
              type: "integer",
              required: true,
              description: "Number of memories in the directory.",
            },
            memories: {
              type: "array",
              required: true,
              description: "Name + description index of the memories, ordered by name. Memory content is intentionally not returned.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: {
                    type: "string",
                    required: true,
                    description: "Memory name (letters, digits, underscores, hyphens).",
                  },
                  description: {
                    type: "string",
                    required: true,
                    description: "One-line summary of the memory.",
                  },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const where = value.type === "global" ? "the global directory" : `workspace ${value.cwd}`;
          const count = value.count === 1 ? "1 memory" : `${value.count} memories`;
          const lines = value.memories.map((memory) => `- ${memory.name}: ${memory.description}`);
          return [{ type: "text", text: lines.length === 0 ? `No memories in ${where}.` : `${count} in ${where}:\n${lines.join("\n")}` }];
        },
      },
      async execute(args, exec) {
        const agent = requireAgent(exec, "memory_list");
        const cwd = args.type === "workspace" ? resolveCwd(agent, "memory_list") : undefined;
        const records = await memoryStore.list({ type: args.type, cwd });
        const memories = records.map((record) => ({ name: record.name, description: record.description }));
        return {
          type: args.type,
          ...(cwd !== undefined ? { cwd } : {}),
          count: memories.length,
          memories,
        };
      },
    }),

    defineTool({
      name: "memory_get",
      description:
        "Read the full content of one saved memory by exact name. " +
        "Returns the memory's name, description, and content; use memory_list first to find the exact name. " +
        "The working directory is taken from the current session automatically; it cannot be passed as an argument.",
      parameters: {
        ...scopeParameter(),
        name: {
          type: "string",
          required: true,
          description: "Exact memory name to read (letters, digits, underscores, hyphens).",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            type: {
              type: "string",
              required: true,
              description: "The memory directory the memory lives in (global or workspace).",
            },
            name: {
              type: "string",
              required: true,
              description: "Memory name.",
            },
            description: {
              type: "string",
              required: true,
              description: "One-line summary of the memory.",
            },
            content: {
              type: "string",
              required: true,
              description: "Full memory content, in the user's language.",
            },
          },
        },
        render: (_args, value) => [
          { type: "text", text: `Memory ${value.name} (${scopeLabel(value.type)}):\n${value.description}\n\n${value.content}` },
        ],
      },
      async execute(args, exec) {
        const agent = requireAgent(exec, "memory_get");
        const cwd = args.type === "workspace" ? resolveCwd(agent, "memory_get") : undefined;
        const record = await memoryStore.get({ type: args.type, cwd, name: args.name });
        if (!record) {
          throw new Error(`no memory named ${JSON.stringify(args.name)} in ${scopeLabel(args.type)} scope`);
        }
        return {
          type: args.type,
          name: record.name,
          description: record.description,
          content: record.content,
        };
      },
    }),

    defineTool({
      name: "memory_write",
      description:
        "Save a memory. Use only when the user explicitly asks you to remember something, " +
        "or when you judge the information valuable enough to recall in future sessions. " +
        "You MUST call memory_list on the same directory (type) first: create a new memory when nothing semantically related exists, " +
        "and overwrite the same-named entry when a memory on the same topic already exists — never create duplicates. " +
        "`name` and `description` must be written in English (name: letters, digits, underscores, hyphens only); " +
        "`content` should be in the user's language and ideally no longer than about 300 characters or words. " +
        "The working directory is taken from the current session automatically; it cannot be passed as an argument.",
      parameters: {
        ...scopeParameter(),
        name: {
          type: "string",
          required: true,
          description: "English name for the memory; only letters, digits, underscores, and hyphens ([A-Za-z0-9_-]+).",
        },
        description: {
          type: "string",
          required: true,
          description: "One-line English summary of what this memory contains.",
        },
        content: {
          type: "string",
          required: true,
          description: "The memory content, in the user's language; ideally no more than about 300 characters or words.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: {
              type: "string",
              required: true,
              enum: ["created", "updated"],
              description: "`created` when a new memory was written, `updated` when an existing memory was overwritten.",
            },
            type: {
              type: "string",
              required: true,
              description: "The memory directory written to (global or workspace).",
            },
            name: {
              type: "string",
              required: true,
              description: "The written memory's name.",
            },
            queued: {
              type: "boolean",
              required: true,
              description: "Whether the memory was enqueued for embedding and indexing. Content is intentionally not returned.",
            },
          },
        },
        render: (args, value) => [
          {
            type: "text",
            text: `Memory ${value.name} ${value.action === "created" ? "created" : "updated"} in ${scopeLabel(value.type)} scope and queued for indexing.`,
          },
        ],
      },
      async execute(args, exec) {
        const agent = requireAgent(exec, "memory_write");
        const cwd = args.type === "workspace" ? resolveCwd(agent, "memory_write") : undefined;
        if (!db || typeof db.upsertMemory !== "function") {
          throw new Error("memory_write is unavailable: the index database is not open");
        }
        if (!indexer || typeof indexer.wake !== "function") {
          throw new Error("memory_write is unavailable: the indexer is not running");
        }
        if (!/^[A-Za-z0-9_-]+$/.test(args.name)) {
          throw new Error("invalid memory name: only letters, digits, underscores, and hyphens are allowed");
        }
        if (args.description.trim().length === 0) {
          throw new Error("invalid memory description: expected a non-empty string");
        }
        if (args.content.trim().length === 0) {
          throw new Error("invalid memory content: expected a non-empty string");
        }
        const { action, record } = await memoryStore.write({
          type: args.type,
          cwd,
          name: args.name,
          description: args.description,
          content: args.content,
        });
        try {
          db.upsertMemory(record);
        } catch (err) {
          throw new Error(`memory saved but failed to enqueue it for indexing: ${String(err?.message ?? err ?? "unknown error")}`);
        }
        indexer.wake();
        return { action, type: args.type, name: args.name, queued: true };
      },
    }),

    defineTool({
      name: "memory_forget",
      description:
        "Forget (delete) a saved memory. Call this ONLY when the user explicitly asks to remove a memory — never on your own initiative. " +
        "The memory is deleted only when BOTH the name and the description exactly match an existing memory; " +
        "use memory_list first to obtain the exact values. " +
        "The working directory is taken from the current session automatically; it cannot be passed as an argument.",
      parameters: {
        ...scopeParameter(),
        name: {
          type: "string",
          required: true,
          description: "Exact name of the memory to forget.",
        },
        description: {
          type: "string",
          required: true,
          description: "Exact one-line description of the memory to forget; deletion happens only when it matches exactly.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            removed: {
              type: "boolean",
              required: true,
              description: "`true` when the memory was forgotten and removed from the index; `false` when nothing matched.",
            },
            type: {
              type: "string",
              required: true,
              description: "The memory directory that was targeted (global or workspace).",
            },
            name: {
              type: "string",
              required: true,
              description: "The targeted memory's name.",
            },
          },
        },
        render: (args, value) => [
          {
            type: "text",
            text: value.removed
              ? `Memory ${value.name} forgotten and removed from the index.`
              : `No memory named ${value.name} with a matching description was found; nothing was deleted.`,
          },
        ],
      },
      async execute(args, exec) {
        const agent = requireAgent(exec, "memory_forget");
        const cwd = args.type === "workspace" ? resolveCwd(agent, "memory_forget") : undefined;
        if (!db || typeof db.deletePair !== "function") {
          throw new Error("memory_forget is unavailable: the index database is not open");
        }
        const result = await memoryStore.remove({
          type: args.type,
          cwd,
          name: args.name,
          description: args.description,
        });
        if (!result) {
          return { removed: false, type: args.type, name: args.name };
        }
        db.deletePair(result.record.pairId);
        return { removed: true, type: args.type, name: args.name };
      },
    }),
  ];
}

/**
 * Register the four memory tools on a context that exposes the host's tool
 * registry. Registration lifecycle (unregistering on teardown) is owned by
 * `ctx.tools.register` itself.
 *
 * @param {object} ctx - Context providing the `tools` service.
 * @param {object} deps
 * @param {object} deps.memoryStore - Memory store from `createMemoryStore`.
 * @param {object|null} deps.db - Index database (may be null; tools then fail
 *   clearly at call time).
 * @param {object|null} deps.indexer - Background indexer (may be null).
 * @param {object|null} [deps.configStore] - Config store (reserved).
 * @returns {number} Number of registered tools.
 * @throws {Error} When `ctx.tools` is unavailable or `memoryStore` is missing.
 */
export function registerMemoryTools(ctx, { memoryStore, db, indexer, configStore } = {}) {
  const tools = ctx?.tools;
  if (!tools || typeof tools.register !== "function") {
    throw new Error("registerMemoryTools requires a ctx with a tools service (ctx.tools.register)");
  }
  if (!memoryStore) {
    throw new Error("registerMemoryTools requires a memoryStore");
  }
  const definitions = createMemoryToolDefinitions({ memoryStore, db, indexer, configStore });
  for (const definition of definitions) {
    tools.register(definition);
  }
  return definitions.length;
}
