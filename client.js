"use strict";

// @local/dsh-context-rag -- DSH web client plugin: config page for the
// dsh-context-rag backend service. Registers a "plugins.bundle.config" slot so
// the panel renders on the bundle's own page, and talks to the REST API of the
// server plugin.

window.__ModuleLoader__.load({
  id: "@local/dsh-context-rag",
  factory(require) {
    const React = require("react");
    const API = "/plugins/dsh-context-rag/api";
    const LOCALE = "contextRag";

    // Deep copy of the config with write-only apiKey fields removed.
    function publicConfig(config) {
      const copy = JSON.parse(JSON.stringify(config || {}));
      if (copy.embedding) delete copy.embedding.apiKey;
      if (copy.rerank) delete copy.rerank.apiKey;
      return copy;
    }

    // POST {action,payload} -> {ok:true,value}, throws on {ok:false,error}.
    async function call(action, payload = {}) {
      let res;
      try {
        res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, payload }) });
      } catch (err) {
        throw new Error("Network error: " + (err && err.message));
      }
      const data = await res.json().catch(() => null);
      if (!data || data.ok !== true) {
        const error = data && data.error;
        const thrown = new Error(
          typeof error === "string" ? error : (error && error.message) || "Request failed",
        );
        if (error && typeof error === "object") {
          thrown.code = error.code;
          thrown.status = error.status;
        }
        throw thrown;
      }
      return data.value;
    }

    // Short alias to keep the JSX-free tree readable.
    const el = (tag, props, ...children) => React.createElement(tag, props, ...children);

    function ConfigPage({ t }) {
      const [status, setStatus] = React.useState(null);
      const [configText, setConfigText] = React.useState("");
      const [busy, setBusy] = React.useState("");
      const [banner, setBanner] = React.useState(null);
      const [confirmClear, setConfirmClear] = React.useState(false);

      const parsedConfig = () => {
        try { return JSON.parse(configText) || {}; } catch { return null; }
      };
      const updateField = (path, value) => {
        const base = parsedConfig();
        if (!base) return;
        const parts = path.split(".");
        let node = base;
        for (let i = 0; i < parts.length - 1; i += 1) {
          if (!node[parts[i]] || typeof node[parts[i]] !== "object") node[parts[i]] = {};
          node = node[parts[i]];
        }
        node[parts[parts.length - 1]] = value;
        setConfigText(JSON.stringify(base, null, 2));
      };
      const read = (path, fallback) => {
        const base = parsedConfig();
        if (!base) return fallback;
        return path.split(".").reduce((v, k) => (v && typeof v === "object" ? v[k] : undefined), base) ?? fallback;
      };

      const reload = React.useCallback(async () => {
        setBusy("status");
        try {
          const value = await call("status");
          setStatus(value);
          setConfigText(JSON.stringify(publicConfig(value && value.config), null, 2));
        } catch (err) {
          setBanner({ kind: "error", text: err.message });
        } finally {
          setBusy("");
        }
      }, []);

      React.useEffect(() => {
        reload();
      }, [reload]);

      const save = async () => {
        let parsed;
        try {
          parsed = JSON.parse(configText);
          for (const key of ["embedding", "rerank"]) {
            if (parsed && parsed[key]) {
              delete parsed[key].apiKeySet;
              delete parsed[key].apiKeyPreview;
            }
          }
        } catch (err) {
          setBanner({ kind: "error", text: t("jsonInvalid") });
          return;
        }
        setBusy("save");
        try {
          await call("config.save", { config: parsed });
          setBanner({ kind: "success", text: t("saved") });
          await reload();
        } catch (err) {
          setBanner({ kind: "error", text: err.message });
          setBusy("");
        }
      };

      const test = async (action) => {
        setBusy(action);
        try {
          const value = await call(action);
          setBanner({ kind: "success", text: t("testOk") + (value ? ": " + JSON.stringify(value) : "") });
        } catch (err) {
          setBanner({ kind: "error", text: err.message });
        } finally {
          setBusy("");
        }
        await reload();
      };

      const rebuild = async () => {
        setBusy("rebuild");
        try {
          await call("index.rebuild");
          setBanner({ kind: "success", text: t("rebuilt") });
          await reload();
        } catch (err) {
          setBanner({ kind: "error", text: err.message });
          setBusy("");
        }
      };

      const clear = async () => {
        // Two-click confirmation before wiping the index.
        if (!confirmClear) {
          setConfirmClear(true);
          return;
        }
        setConfirmClear(false);
        setBusy("clear");
        try {
          await call("index.clear");
          setBanner({ kind: "success", text: t("cleared") });
          await reload();
        } catch (err) {
          setBanner({ kind: "error", text: err.message });
          setBusy("");
        }
      };

      const disabled = busy !== "";
      const config = (status && status.config) || {};
      const counts = (status && status.stats) || {};
      const runtime = (status && status.runtime) || {};
      const embed = config.embedding || {};
      const model = embed.model || t("unknown");
      const dim = counts.dim ?? t("unknown");

      const stat = (label, value) => el("div", { className: "dscr-stat" }, el("div", { className: "dscr-stat-value" }, value), el("div", { className: "dscr-stat-label" }, label));
      const field = (label, value) => el("div", { className: "dscr-field" }, el("span", { className: "dscr-field-label" }, label), el("span", { className: "dscr-field-value" }, value));
      const btn = (label, onClick) => el("button", { className: "dscr-btn", type: "button", disabled, onClick }, label);
      const bannerNode = banner ? el("div", { className: "dscr-banner" + (banner.kind === "error" ? " dscr-banner-error" : ""), role: "status", "aria-live": "polite" }, el("strong", null, banner.kind === "error" ? t("error") : t("ok")), " " + banner.text) : null;

      const formDisabled = disabled || !parsedConfig();

      const checkRow = (labelKey, path) =>
        el("div", { className: "dscr-form-row" },
          el("div", { className: "dscr-check" },
            el("input", { type: "checkbox", checked: !!read(path, false), disabled: formDisabled, onChange: (e) => updateField(path, e.target.checked) }),
            el("label", null, t(labelKey))));

      const textRow = (labelKey, path) =>
        el("div", { className: "dscr-form-row" },
          el("label", null, t(labelKey)),
          el("input", {
            className: "dscr-input",
            type: "text",
            value: read(path, "") ?? "",
            disabled: formDisabled,
            onChange: (e) => updateField(path, e.target.value),
          }));

      const numRow = (labelKey, path, { int = false, step, min, max, fixed } = {}) => {
        const raw = read(path, "");
        // Score fields show exactly two decimals (e.g. 0.40, not 0.4).
        const value = typeof fixed === "number" && typeof raw === "number" && Number.isFinite(raw)
          ? raw.toFixed(fixed)
          : raw;
        return el("div", { className: "dscr-form-row" },
          el("label", null, t(labelKey)),
          el("input", {
            className: "dscr-input",
            type: "number",
            step,
            min,
            max,
            value,
            disabled: formDisabled,
            onChange: (e) => {
              const v = e.target.value;
              if (v === "") { updateField(path, null); return; }
              const n = int ? Number.parseInt(v, 10) : Number(v);
              updateField(path, Number.isNaN(n) ? null : n);
            },
          }));
      };

      const apiKeyRow = (labelKey, path) =>
        el("div", { className: "dscr-form-row" },
          el("label", null, t(labelKey)),
          el("input", {
            className: "dscr-input",
            type: "password",
            value: read(path, "") ?? "",
            placeholder: read(path + "Preview", "") || t("notSet"),
            disabled: formDisabled,
            onChange: (e) => { if (e.target.value !== "") updateField(path, e.target.value); },
          }),
          el("button", { className: "dscr-btn", type: "button", disabled: formDisabled, onClick: () => updateField(path, null) }, t("clearKey")));

      const scopeRow =
        el("div", { className: "dscr-form-row" },
          el("label", null, t("scope")),
          el("select", { className: "dscr-input", value: read("retrieval.scope", "workspace"), disabled: formDisabled, onChange: (e) => updateField("retrieval.scope", e.target.value) },
            el("option", { value: "workspace" }, t("scopeWorkspace")),
            el("option", { value: "all" }, t("scopeAll"))));

      // One card per configuration category, so embedding, rerank, retrieval,
      // and indexing settings stay visually separate. `help` is an optional
      // translation key rendered as a help paragraph below the form rows.
      const formCard = (titleKey, rows, { hint = false, help } = {}) =>
        el("div", { className: "dscr-card" },
          el("h2", { className: "dscr-title" }, t(titleKey)),
          hint && !parsedConfig() ? el("p", { className: "dscr-help" }, t("invalidJsonHint")) : null,
          el("div", { className: "dscr-form" }, ...rows),
          help ? el("p", { className: "dscr-help" }, t(help)) : null);

      const settingsCards = [
        formCard("embeddingTitle", [
          checkRow("enabled", "enabled"),
          textRow("embeddingBaseUrl", "embedding.baseUrl"),
          textRow("embeddingModel", "embedding.model"),
          numRow("dimensions", "embedding.dimensions", { int: true }),
          apiKeyRow("apiKey", "embedding.apiKey"),
          numRow("timeoutMs", "embedding.timeoutMs", { int: true }),
          numRow("maxRetries", "embedding.maxRetries", { int: true }),
          numRow("batchSize", "embedding.batchSize", { int: true }),
          numRow("maxEmbeddingChars", "embedding.maxEmbeddingChars", { int: true }),
        ], { hint: true }),
        formCard("rerankTitle", [
          checkRow("rerankEnabled", "rerank.enabled"),
          textRow("rerankBaseUrl", "rerank.baseUrl"),
          textRow("rerankModel", "rerank.model"),
          textRow("rerankPath", "rerank.path"),
          apiKeyRow("apiKey", "rerank.apiKey"),
        ]),
        formCard("retrievalTitle", [
          checkRow("injectionEnabled", "retrieval.injectionEnabled"),
          checkRow("allowSameSession", "retrieval.allowSameSession"),
          scopeRow,
          numRow("candidateLimit", "retrieval.candidateLimit", { int: true }),
          numRow("topK", "retrieval.topK", { int: true }),
          numRow("minScore", "retrieval.minScore", { step: 0.01, min: 0, max: 1, fixed: 2 }),
          numRow("rerankMinScore", "retrieval.rerankMinScore", { step: 0.01, min: 0, max: 1, fixed: 2 }),
          numRow("maxContextChars", "retrieval.maxContextChars", { int: true }),
          numRow("timeoutMs", "retrieval.timeoutMs", { int: true }),
          numRow("dedupeTurns", "retrieval.dedupeTurns", { int: true, min: -1 }),
          numRow("dedupeStateRetentionDays", "retrieval.dedupeStateRetentionDays", { int: true, min: 0 }),
          numRow("dedupeStateMaxSessions", "retrieval.dedupeStateMaxSessions", { int: true, min: 0 }),
        ], { help: "dedupeHelp" }),
        formCard("indexingTitle", [
          checkRow("indexingEnabled", "indexing.enabled"),
          numRow("pollIntervalMs", "indexing.pollIntervalMs", { int: true }),
          numRow("retryDelayMs", "indexing.retryDelayMs", { int: true }),
          numRow("maxAttempts", "indexing.maxAttempts", { int: true }),
        ]),
      ];

      return el("div", { className: "dscr-page" },
        el("div", { className: "dscr-card", "aria-label": t("title") },
          el("h2", { className: "dscr-title" }, t("title")),
          el("div", { className: "dscr-grid" },
            stat(t("pairCount"), counts.pairCount ?? 0),
            stat(t("indexedCount"), counts.indexedCount ?? 0),
            stat(t("pendingCount"), counts.pendingCount ?? 0),
            stat(t("errorCount"), counts.errorCount ?? 0)),
          field(t("homePath"), config.home || t("none")),
          field(t("embedding"), model),
          field(t("dim"), dim),
          field(t("indexer"), runtime.indexerRunning ? t("running") : t("stopped")),
          field(t("initError"), runtime.initError || t("none")),
          field(t("lastError"), runtime.lastError || t("none"))),
        ...settingsCards,
        el("div", { className: "dscr-card" },
          el("h2", { className: "dscr-title" }, t("advancedTitle")),
          el("textarea", { className: "dscr-textarea", value: configText, spellCheck: false, "aria-label": t("advancedTitle"), onChange: (e) => setConfigText(e.target.value) }),
          el("p", { className: "dscr-help" }, t("configHelp"))),
        el("div", { className: "dscr-card" },
          el("div", { className: "dscr-btns" },
            btn(t("reload"), reload), btn(t("save"), save),
            btn(t("testEmbedding"), () => test("connection.testEmbedding")),
            btn(t("testRerank"), () => test("connection.testRerank")),
            btn(t("rebuild"), rebuild), btn(t(confirmClear ? "confirmClear" : "clear"), clear)),
          busy ? el("div", { className: "dscr-busy", role: "status", "aria-live": "polite" }, t("busy") + " " + busy) : null),
        bannerNode);
    }

    // ------------------------------------------------------------------
    // plugin
    // ------------------------------------------------------------------

    const messages = {
      en: {
        title: "Context RAG",
        pairCount: "Pairs", indexedCount: "Indexed", pendingCount: "Pending", errorCount: "Errors",
        homePath: "Home path", embedding: "Embedding model", dim: "Dimensions", indexer: "Indexer",
        running: "running", stopped: "stopped", initError: "Init error", lastError: "Last error", none: "none", unknown: "unknown",
        configTitle: "Configuration (JSON)",
        advancedTitle: "Advanced JSON",
        embeddingTitle: "Embedding", rerankTitle: "Rerank", retrievalTitle: "Retrieval", indexingTitle: "Indexing",
        notSet: "not set", invalidJsonHint: "Invalid JSON — editing disabled.",
        enabled: "Enabled", embeddingBaseUrl: "Embedding base URL", embeddingModel: "Embedding model",
        dimensions: "Dimensions", apiKey: "API key", clearKey: "Clear key",
        timeoutMs: "Timeout (ms)", maxRetries: "Max retries", batchSize: "Batch size",
        maxEmbeddingChars: "Max embedding chars",
        rerankEnabled: "Rerank enabled", rerankBaseUrl: "Rerank base URL", rerankModel: "Rerank model", rerankPath: "Rerank path",
        injectionEnabled: "Inject context", scope: "Scope", scopeWorkspace: "Workspace", scopeAll: "All",
        allowSameSession: "Allow same-session recall", dedupeTurns: "Dedupe turns",
        dedupeStateRetentionDays: "Recall-state retention (days)", dedupeStateMaxSessions: "Recall-state max sessions",
        candidateLimit: "Candidate limit", topK: "Top K", minScore: "Min cosine score", rerankMinScore: "Min rerank score", maxContextChars: "Max context chars",
        dedupeHelp: "Dedupe turns: 5 default; 0 disables turn dedupe; -1 allows each pair only once per session. Retention values of 0 disable that limit.",
        indexingEnabled: "Indexing enabled", pollIntervalMs: "Poll interval (ms)", retryDelayMs: "Retry delay (ms)", maxAttempts: "Max attempts",
        configHelp: "Edit the JSON directly. API keys are write-only: add a string \"apiKey\" field (e.g. embedding.apiKey) to set one; it is sent to the server and never shown again (apiKeySet / apiKeyPreview only indicate whether a key is set).",
        reload: "Reload", save: "Save", testEmbedding: "Test embedding", testRerank: "Test rerank",
        rebuild: "Rebuild index", clear: "Clear index", confirmClear: "Click again to confirm",
        saved: "Configuration saved.", cleared: "Index cleared.", rebuilt: "Index rebuilt.",
        testOk: "Connection OK", jsonInvalid: "Invalid JSON", busy: "Busy", ok: "OK", error: "Error",
      },
      zh: {
        title: "Context RAG",
        pairCount: "条目数", indexedCount: "已索引", pendingCount: "待处理", errorCount: "错误",
        homePath: "主页路径", embedding: "嵌入模型", dim: "维度", indexer: "索引器",
        running: "运行中", stopped: "已停止", initError: "初始化错误", lastError: "最近错误", none: "无", unknown: "未知",
        configTitle: "配置",
        advancedTitle: "高级 JSON",
        embeddingTitle: "嵌入", rerankTitle: "重排", retrievalTitle: "检索", indexingTitle: "索引",
        notSet: "未设置", invalidJsonHint: "JSON 无效——已禁用编辑。",
        enabled: "启用", embeddingBaseUrl: "嵌入接口地址", embeddingModel: "嵌入模型",
        dimensions: "维度", apiKey: "API 密钥", clearKey: "清除密钥",
        timeoutMs: "超时（毫秒）", maxRetries: "最大重试次数", batchSize: "批大小",
        maxEmbeddingChars: "最大嵌入字符数",
        rerankEnabled: "启用重排", rerankBaseUrl: "重排接口地址", rerankModel: "重排模型", rerankPath: "重排路径",
        injectionEnabled: "注入上下文", scope: "检索范围", scopeWorkspace: "当前工作区", scopeAll: "全部工作区",
        allowSameSession: "允许同会话召回", dedupeTurns: "去重轮次",
        dedupeStateRetentionDays: "召回状态保留天数", dedupeStateMaxSessions: "召回状态最大会话数",
        candidateLimit: "候选数量", topK: "最终条数", minScore: "余弦最低分", rerankMinScore: "重排最低分", maxContextChars: "上下文字符上限",
        dedupeHelp: "去重轮次：默认 5；设为 0 禁用轮次去重；设为 -1 表示每条记录在每个会话中仅召回一次。保留值为 0 表示不限制。",
        indexingEnabled: "启用索引", pollIntervalMs: "轮询间隔（毫秒）", retryDelayMs: "重试延迟（毫秒）", maxAttempts: "最大尝试次数",
        configHelp: "直接编辑 JSON。API 密钥为只写：添加字符串字段 \"apiKey\"（如 embedding.apiKey）即可设置；密钥只发送给服务器、永不显示（仅通过 apiKeySet / apiKeyPreview 表明是否已设置）。",
        reload: "重新加载", save: "保存", testEmbedding: "测试嵌入", testRerank: "测试重排",
        rebuild: "重建索引", clear: "清空索引", confirmClear: "再次点击确认",
        saved: "配置已保存。", cleared: "索引已清空。", rebuilt: "索引已重建。",
        testOk: "连接成功", jsonInvalid: "JSON 无效", busy: "处理中", ok: "成功", error: "错误",
      },
    };

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement("style");
          style.id = "dsh-context-rag-styles";
          style.textContent = [
            ".dscr-page { max-width: 840px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; padding: 16px; }",
            ".dscr-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); padding: 16px; color: var(--dsw-alias-label-primary, inherit); } .dscr-title { font-size: 16px; font-weight: 600; margin: 0 0 12px; color: var(--dsw-alias-label-primary, inherit); }",
            ".dscr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin-bottom: 12px; } .dscr-stat { background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); padding: 8px 12px; }",
            ".dscr-stat-value { font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); } .dscr-stat-label { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }",
            ".dscr-field { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; font-size: 13px; } .dscr-field-label { color: var(--dsw-alias-label-secondary, inherit); } .dscr-field-value { color: var(--dsw-alias-label-primary, inherit); text-align: right; overflow-wrap: anywhere; }",
            ".dscr-textarea { width: 100%; min-height: 220px; box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; padding: 8px; color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); resize: vertical; }",
            ".dscr-help { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); margin: 8px 0 0; } .dscr-btns { display: flex; flex-wrap: wrap; gap: 8px; }",
            ".dscr-btn { padding: 6px 12px; font-size: 13px; cursor: pointer; color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); } .dscr-btn:disabled { opacity: 0.5; cursor: default; }",
            ".dscr-busy { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); margin-top: 8px; } .dscr-banner { margin-top: 4px; padding: 8px 12px; font-size: 13px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary, inherit); } .dscr-banner-error strong { color: var(--dsw-alias-state-error-primary, inherit); }",
            ".dscr-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 16px; } .dscr-form-row { display: flex; flex-direction: column; gap: 4px; } .dscr-form-row label { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); } .dscr-input { padding: 6px 8px; font-size: 13px; color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); } .dscr-check { display: flex; align-items: center; gap: 6px; }",
          ].join("\n");
          document.head.appendChild(style);
          return () => {
            if (style.parentNode) style.parentNode.removeChild(style);
          };
        });

        // Register the inline EN/ZH locale for this plugin.
        if (ctx.locale && typeof ctx.locale.register === "function") {
          ctx.effect(
            () => ctx.locale.register(LOCALE, messages),
            "context-rag: locale",
          );
        } else if (typeof ctx.locale === "function") {
          ctx.effect(() => ctx.locale(LOCALE, messages), "context-rag: locale");
        }

        // Mount the config page on the bundle's own detail page, above the
        // Components section. Singular bundle config, keyed by package name.
        ctx.slots.inject("plugins.bundle.config", () =>
          ctx.slots.register(
            {
              name: "plugins.bundle.config",
              key: "@local/dsh-context-rag",
              locale: LOCALE,
            },
            ConfigPage
          )
        );
      },
    };
  },
});
