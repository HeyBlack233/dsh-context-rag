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

    // Tab ids are shared by the tab buttons and their panels for aria links.
    const tabDomId = (id) => "dscr-tab-" + id;
    const panelDomId = (id) => "dscr-panel-" + id;
    const TAB_IDS = ["dashboard", "browse", "configuration", "logs"];
    const TAB_STORAGE_KEY = "dsh-context-rag:tab";

    function storedTab() {
      try {
        const value = window.localStorage.getItem(TAB_STORAGE_KEY);
        return TAB_IDS.includes(value) ? value : "dashboard";
      } catch {
        return "dashboard";
      }
    }

    function rememberTab(id) {
      try {
        window.localStorage.setItem(TAB_STORAGE_KEY, id);
      } catch {
        // Storage may be unavailable (private mode); the tab still works.
      }
    }

    // Index size in a compact human-readable form. Unit labels are translated
    // so every user-visible string stays localizable.
    function formatBytes(value, t) {
      const units = ["unitB", "unitKB", "unitMB", "unitGB"];
      if (!Number.isFinite(value) || value <= 0) return "0 " + t(units[0]);
      let size = value;
      let unit = 0;
      while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit += 1;
      }
      return (unit === 0 ? String(size) : size.toFixed(1)) + " " + t(units[unit]);
    }

    // ------------------------------------------------------------------
    // Browse tab helpers (pure; no React state)
    // ------------------------------------------------------------------

    const BROWSE_PAGE_SIZE = 20;
    // Manual search returns at most this many mixed results (memories + pairs).
    const BROWSE_SEARCH_LIMIT = 20;

    function browseBasename(path) {
      if (!path) return "";
      const parts = String(path).split(/[\\/]/);
      return parts[parts.length - 1] || "";
    }

    // Pair createdAt is an ISO string; memory createdAt is epoch milliseconds.
    function browseDate(value) {
      if (value === null || value === undefined || value === "") return "";
      const ms = typeof value === "number" ? value : Date.parse(value);
      if (!Number.isFinite(ms)) return String(value);
      return new Date(ms).toLocaleString();
    }

    function sameBrowseScope(a, b) {
      return !!a && !!b && a.type === b.type && (a.cwd || "") === (b.cwd || "");
    }

    // Item status states use dashed names; check counts use camelCase names.
    function statusKey(state) {
      switch (state) {
        case "consistent": return "statusConsistent";
        case "missing": return "statusMissing";
        case "stale-text": return "statusStale";
        case "pending": return "statusPending";
        case "model-mismatch": return "statusModel";
        case "corrupt": return "statusCorrupt";
        case "orphan": return "statusOrphan";
        default: return "statusUnknown";
      }
    }

    function countStatusKey(key) {
      switch (key) {
        case "consistent": return "statusConsistent";
        case "missing": return "statusMissing";
        case "staleText": return "statusStale";
        case "pending": return "statusPending";
        case "modelMismatch": return "statusModel";
        case "corrupt": return "statusCorrupt";
        case "orphan": return "statusOrphan";
        default: return "statusUnknown";
      }
    }

    function statusClass(state) {
      return "dscr-browse-pill" + (state ? " dscr-browse-pill-" + state : " dscr-browse-pill-unknown");
    }

    // Global scope is memories-only; pairing with it falls back to "all".
    function fixupBrowseScope(scope, scopes, kind) {
      const current = scope || { type: "all" };
      if (kind === "pairs" && current.type === "global") return { type: "all" };
      if (current.type === "workspace") {
        const known = (scopes || []).some((s) => s.type === "workspace" && s.cwd === current.cwd);
        if (!known) return { type: "all" };
      }
      return current;
    }

    function scopeSelectValue(scope) {
      return scope && scope.type === "workspace" ? "workspace:" + (scope.cwd || "") : (scope && scope.type) || "all";
    }

    // Accessible tab bar: arrow keys, Home, and End move and activate tabs.
    function TabBar({ tabs, active, onChange, t }) {
      const onKeyDown = (event) => {
        const index = tabs.findIndex((tab) => tab.id === active);
        if (index < 0) return;
        let next = null;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        if (next === null) return;
        event.preventDefault();
        const tab = tabs[next];
        onChange(tab.id);
        // Focus moves to the newly active tab; its panel follows below.
        const target = event.currentTarget.querySelector("#" + tabDomId(tab.id));
        if (target) target.focus();
      };
      return el("div", {
        className: "dscr-tabs",
        role: "tablist",
        "aria-label": t("tabsLabel"),
        onKeyDown,
      }, ...tabs.map((tab) => el("button", {
        key: tab.id,
        id: tabDomId(tab.id),
        className: "dscr-tab" + (active === tab.id ? " dscr-tab-active" : ""),
        type: "button",
        role: "tab",
        "aria-selected": active === tab.id,
        "aria-controls": panelDomId(tab.id),
        tabIndex: active === tab.id ? 0 : -1,
        "aria-label": tab.dirty ? t(tab.labelKey) + ", " + t("unsaved") : undefined,
        onClick: () => onChange(tab.id),
      }, t(tab.labelKey), tab.dirty ? el("span", { className: "dscr-tab-dot", "aria-hidden": "true" }) : null)));
    }

    function ConfigPage({ t }) {
      const [status, setStatus] = React.useState(null);
      const [configText, setConfigText] = React.useState("");
      const [savedText, setSavedText] = React.useState("");
      const [busy, setBusy] = React.useState("");
      const [banner, setBanner] = React.useState(null);
      const [confirmClear, setConfirmClear] = React.useState(false);
      const [activeTab, setActiveTab] = React.useState(storedTab);
      const [advancedOpen, setAdvancedOpen] = React.useState(false);
      // Logs tab state. logLimitText holds the raw N input value so typing is
      // never clobbered by the 2 s poll; the applied limit lives in logLimit.
      const [logEntries, setLogEntries] = React.useState([]);
      const [logLimit, setLogLimit] = React.useState(200);
      const [logDebug, setLogDebug] = React.useState(false);
      const [logLimitText, setLogLimitText] = React.useState("200");
      const [logBusy, setLogBusy] = React.useState("");
      const [logError, setLogError] = React.useState("");
      const logListRef = React.useRef(null);
      // True once the user edits the N input, so polling does not overwrite a
      // value that is still being typed or is about to be applied.
      const logLimitEditedRef = React.useRef(false);
      // Follow the newest entry while the reader is at the bottom; scrolling up
      // pauses this until the reader returns to the bottom.
      const logFollowRef = React.useRef(true);
      // Bumped around logs.configure so a poll that started before (or during)
      // the request cannot overwrite the freshly applied settings.
      const logEpochRef = React.useRef(0);

      // Browse tab state. Loaded lazily only while the Browse tab is active;
      // nothing polls while it is hidden. browseList holds the last
      // browse.list response (paged view); browseCheck holds the last
      // successful browse.check for the current scope and is invalidated on
      // scope/mode change; browseOnlyMismatch swaps the list for the check's
      // mismatches.
      const [browseKind, setBrowseKind] = React.useState("memories");
      const [browseScopes, setBrowseScopes] = React.useState([]);
      const [browseScope, setBrowseScope] = React.useState({ type: "all" });
      const [browseList, setBrowseList] = React.useState(null);
      const [browseLoading, setBrowseLoading] = React.useState(false);
      const [browseError, setBrowseError] = React.useState("");
      const [browseSelected, setBrowseSelected] = React.useState(null);
      const [browseDetail, setBrowseDetail] = React.useState(null);
      const [browseDetailLoading, setBrowseDetailLoading] = React.useState(false);
      const [browseDetailError, setBrowseDetailError] = React.useState("");
      const [browseCheck, setBrowseCheck] = React.useState(null);
      const [browseChecking, setBrowseChecking] = React.useState(false);
      const [browseOnlyMismatch, setBrowseOnlyMismatch] = React.useState(false);
      const [browseBusy, setBrowseBusy] = React.useState("");
      const [browseBanner, setBrowseBanner] = React.useState(null);
      const [browseConfirmForget, setBrowseConfirmForget] = React.useState(false);
      // Manual search over memories + pairs. browseSearchQuery holds the raw
      // input text; browseSearchActive is the query currently displayed (null
      // while the search is off); browseSearchResult is the last successful
      // browse.search response. Search state lives in-page, so results may
      // persist across tab switches.
      const [browseSearchQuery, setBrowseSearchQuery] = React.useState("");
      const [browseSearchActive, setBrowseSearchActive] = React.useState(null);
      const [browseSearchResult, setBrowseSearchResult] = React.useState(null);
      const [browseSearching, setBrowseSearching] = React.useState(false);
      const [browseSearchError, setBrowseSearchError] = React.useState("");
      // Monotonic epochs invalidate in-flight list loads, checks, and detail
      // fetches after a scope/mode switch, so a stale response can never
      // overwrite newer state.
      const browseEpochRef = React.useRef(0);
      const browseDetailEpochRef = React.useRef(0);

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

      // The buffer is append-only (oldest entries are trimmed from the head),
      // so equal length plus equal head/tail identify the same window. This
      // lets a 2 s poll bail out without touching React state when nothing
      // changed, even with the maximum N.
      const sameLogWindow = (prev, next) => {
        if (prev === next) return true;
        if (!Array.isArray(prev) || !Array.isArray(next) || prev.length !== next.length) return false;
        if (prev.length === 0) return true;
        const prevFirst = prev[0];
        const prevLast = prev[prev.length - 1];
        const nextFirst = next[0];
        const nextLast = next[next.length - 1];
        return prevFirst.time === nextFirst.time
          && prevFirst.message === nextFirst.message
          && prevLast.time === nextLast.time
          && prevLast.level === nextLast.level
          && prevLast.message === nextLast.message;
      };

      // Apply a logs.get / logs.configure response to the logs state. A
      // same-window response keeps the previous entries array so React does
      // not re-render thousands of rows on every 2 s poll.
      const setLogs = (value) => {
        const nextEntries = Array.isArray(value && value.entries) ? value.entries : [];
        setLogEntries((prev) => (sameLogWindow(prev, nextEntries) ? prev : nextEntries));
        if (value && typeof value === "object") {
          if (typeof value.limit === "number") {
            setLogLimit(value.limit);
            // Follow the server-side limit until the user starts editing; after
            // that the input is theirs until Apply succeeds.
            if (!logLimitEditedRef.current) setLogLimitText(String(value.limit));
          }
          if (typeof value.debug === "boolean") setLogDebug(value.debug);
        }
      };

      // Shared success path for polls and manual refresh.
      const applyLogsValue = (value) => {
        setLogs(value);
        setLogError("");
      };

      // After logs.configure succeeds, mirror the new logging fields into both
      // configuration snapshots (configText and savedText) so a later Save in
      // the Configuration tab cannot roll bufferSize/debug back. Snapshots that
      // do not parse are kept verbatim; the user's other unsaved edits survive.
      // Only the snapshots are patched here; the server config is untouched.
      const patchConfigSnapshot = ({ bufferSize, debug } = {}) => {
        const patch = {};
        if (bufferSize !== undefined) patch.bufferSize = bufferSize;
        if (debug !== undefined) patch.debug = debug;
        if (Object.keys(patch).length === 0) return;
        const applyTo = (text) => {
          try {
            const obj = JSON.parse(text);
            if (!obj || typeof obj !== "object" || Array.isArray(obj)) return text;
            obj.logging = { ...(obj.logging && typeof obj.logging === "object" ? obj.logging : {}), ...patch };
            return JSON.stringify(obj, null, 2);
          } catch {
            return text;
          }
        };
        setConfigText((prev) => applyTo(prev));
        setSavedText((prev) => applyTo(prev));
      };

      const reload = React.useCallback(async () => {
        setBusy("status");
        try {
          const value = await call("status");
          const text = JSON.stringify(publicConfig(value && value.config), null, 2);
          setStatus(value);
          setConfigText(text);
          setSavedText(text);
        } catch (err) {
          setBanner({ kind: "error", text: err.message });
        } finally {
          setBusy("");
        }
      }, []);

      React.useEffect(() => {
        reload();
      }, [reload]);

      // Poll the ring buffer only while the Logs tab is active: immediately on
      // first entry, then every 2000 ms. Leaving the tab or unmounting clears
      // the interval and stops late setState. Poll failures render as a local
      // line inside the Logs card, not a page-level banner every 2 s.
      React.useEffect(() => {
        if (activeTab !== "logs") return;
        let alive = true;
        const poll = async () => {
          const epoch = logEpochRef.current;
          let value;
          try {
            value = await call("logs.get");
          } catch (err) {
            if (alive && epoch === logEpochRef.current) setLogError(err.message);
            return;
          }
          // Discard a response that predates a just-applied configure.
          if (alive && epoch === logEpochRef.current) applyLogsValue(value);
        };
        poll();
        const timer = window.setInterval(poll, 2000);
        return () => {
          alive = false;
          window.clearInterval(timer);
        };
      }, [activeTab]);

      // Follow the newest entries while reading at the bottom; scrolling up
      // pauses auto-scroll so the poll never yanks the list away.
      React.useEffect(() => {
        const node = logListRef.current;
        if (!node || !logFollowRef.current) return;
        node.scrollTop = node.scrollHeight;
      }, [logEntries]);

      // Unsaved edits are detected against the last loaded/saved snapshot, so
      // switching tabs never loses them (the text stays in the parent state).
      const dirty = configText !== savedText;
      const selectTab = (id) => {
        if (id === activeTab) return;
        // Leaving Dashboard disarms the two-click clear confirmation; leaving
        // Browse disarms the two-click forget confirmation.
        if (activeTab === "dashboard") setConfirmClear(false);
        if (activeTab === "browse") setBrowseConfirmForget(false);
        setActiveTab(id);
        rememberTab(id);
      };

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

      const applyLimit = async () => {
        const n = Number(logLimitText);
        if (!Number.isInteger(n) || n < 1 || n > 5000) {
          setBanner({ kind: "error", text: t("logLimitInvalid") });
          return;
        }
        setLogBusy("configure");
        logEpochRef.current += 1;
        try {
          const value = await call("logs.configure", { bufferSize: n });
          logLimitEditedRef.current = false;
          setLogs(value);
          setLogLimitText(String(value.limit));
          patchConfigSnapshot({ bufferSize: value.limit });
          setBanner({ kind: "success", text: t("logConfigured") });
        } catch (err) {
          setBanner({ kind: "error", text: err.message });
        } finally {
          // Invalidate polls that raced with this request, then allow new ones.
          logEpochRef.current += 1;
          setLogBusy("");
        }
      };

      const toggleDebug = async (checked) => {
        // Optimistically reflect the click; a failed save rolls it back.
        const previous = logDebug;
        setLogDebug(checked);
        setLogBusy("configure");
        logEpochRef.current += 1;
        try {
          const value = await call("logs.configure", { debug: checked });
          setLogs(value);
          patchConfigSnapshot({ debug: value.debug });
          setBanner({ kind: "success", text: t("logConfigured") });
        } catch (err) {
          setLogDebug(previous);
          setBanner({ kind: "error", text: err.message });
        } finally {
          logEpochRef.current += 1;
          setLogBusy("");
        }
      };

      // Manual refresh reuses the same fetch-and-apply logic as the poll.
      const refreshLogs = async () => {
        setLogBusy("refresh");
        const epoch = logEpochRef.current;
        try {
          const value = await call("logs.get");
          if (epoch === logEpochRef.current) applyLogsValue(value);
        } catch (err) {
          if (epoch === logEpochRef.current) setLogError(err.message);
        } finally {
          setLogBusy("");
        }
      };

      const exportLogs = async () => {
        setLogBusy("export");
        try {
          const value = await call("logs.export");
          const count = value && Number.isInteger(value.count) ? value.count : 0;
          const path = value && value.path ? value.path : "";
          setBanner({ kind: "success", text: t("logExportOk") + " " + count + " " + t("logCount") + " → " + path });
        } catch (err) {
          setBanner({ kind: "error", text: err.message });
        } finally {
          setLogBusy("");
        }
      };

      // ------------------------------------------------------------------
      // Browse tab: data loading, check index, re-index, forget
      // ------------------------------------------------------------------

      const loadBrowseList = async (scope, kind, offset) => {
        return call("browse.list", { kind, scope, offset, limit: BROWSE_PAGE_SIZE });
      };

      // Fetches one browse.list page and merges it into browseList. offset 0
      // replaces the list; offset > 0 appends (Load more). Responses that are
      // stale (a scope/mode switch happened meanwhile) are dropped.
      const reloadBrowse = async (scope, kind, offset = 0) => {
        const epoch = ++browseEpochRef.current;
        setBrowseLoading(true);
        setBrowseError("");
        try {
          const value = await loadBrowseList(scope, kind, offset);
          if (epoch !== browseEpochRef.current) return null;
          setBrowseList((prev) =>
            offset === 0 || !prev
              ? value
              : { ...value, items: [...prev.items, ...value.items] },
          );
          return value;
        } catch (err) {
          if (epoch !== browseEpochRef.current) return null;
          setBrowseError(err.message);
          return null;
        } finally {
          if (epoch === browseEpochRef.current) setBrowseLoading(false);
        }
      };

      // Manual search over memories + message pairs. The active query is set
      // by the submit handler before the fetch starts; re-runs (scope change,
      // refresh, re-index, forget, re-entering the tab) keep it. Runs share
      // the browse epoch, so a stale search or list response can never
      // overwrite newer state.
      const runBrowseSearch = async (query, scope) => {
        const epoch = ++browseEpochRef.current;
        setBrowseSearching(true);
        setBrowseSearchError("");
        try {
          const value = await call("browse.search", { query, scope, limit: BROWSE_SEARCH_LIMIT });
          if (epoch !== browseEpochRef.current) return null;
          setBrowseSearchResult(value);
          return value;
        } catch (err) {
          if (epoch !== browseEpochRef.current) return null;
          setBrowseSearchError(err.message);
          return null;
        } finally {
          if (epoch === browseEpochRef.current) setBrowseSearching(false);
        }
      };

      const submitBrowseSearch = (event) => {
        event.preventDefault();
        const query = browseSearchQuery.trim();
        // Empty/whitespace query does nothing (the default submit is still
        // prevented so the page does not reload).
        if (!query) return;
        // A fresh query replaces the selection: the old detail may not belong
        // to the new result set.
        setBrowseSelected(null);
        setBrowseDetail(null);
        setBrowseDetailError("");
        setBrowseConfirmForget(false);
        setBrowseSearchActive(query);
        setBrowseSearchResult(null);
        runBrowseSearch(query, browseScope);
      };

      // Turns the search off and returns to the current mode's list. When a
      // search was active the list is reloaded (which also bumps the shared
      // epoch, dropping any in-flight search response); with only input text
      // present the untouched list stays as is.
      const clearBrowseSearch = () => {
        const wasActive = browseSearchActive !== null;
        setBrowseSearchQuery("");
        setBrowseSearchActive(null);
        setBrowseSearchResult(null);
        setBrowseSearchError("");
        setBrowseSearching(false);
        setBrowseSelected(null);
        setBrowseDetail(null);
        setBrowseDetailError("");
        setBrowseConfirmForget(false);
        if (wasActive) reloadBrowse(browseScope, browseKind, 0);
      };

      // Lazy load on first entry: scopes first, then the list for the current
      // kind/scope. Runs every time the Browse tab becomes active, never while
      // it is hidden, and never on a timer. An active search is re-run so its
      // scores and index status are fresh; otherwise the plain list loads.
      React.useEffect(() => {
        if (activeTab !== "browse") return;
        let alive = true;
        setBrowseLoading(true);
        setBrowseError("");
        (async () => {
          try {
            const scopesValue = await call("browse.scopes");
            if (!alive) return;
            const scopes = Array.isArray(scopesValue && scopesValue.scopes) ? scopesValue.scopes : [];
            setBrowseScopes(scopes);
            const scope = fixupBrowseScope(browseScope, scopes, browseKind);
            if (!sameBrowseScope(scope, browseScope)) setBrowseScope(scope);
            if (browseSearchActive) {
              await runBrowseSearch(browseSearchActive, scope);
            } else {
              await reloadBrowse(scope, browseKind, 0);
            }
          } catch (err) {
            if (alive) setBrowseError(err.message);
          } finally {
            if (alive) setBrowseLoading(false);
          }
        })();
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [activeTab]);

      // Mode switch: clear selection, invalidate the check result, keep the
      // scope if it is still valid for the new kind (global is memories-only,
      // so pairs fall back to "all"), reload the list. The mode buttons are
      // disabled while a search is active (the search is mixed), so this only
      // runs from the toolbar.
      const switchBrowseKind = (kind) => {
        if (kind === browseKind) return;
        if (browseSearchActive !== null) return;
        setBrowseKind(kind);
        setBrowseSelected(null);
        setBrowseDetail(null);
        setBrowseDetailError("");
        setBrowseCheck(null);
        setBrowseOnlyMismatch(false);
        setBrowseConfirmForget(false);
        setBrowseList(null);
        const scope = fixupBrowseScope(browseScope, browseScopes, kind);
        if (!sameBrowseScope(scope, browseScope)) setBrowseScope(scope);
        reloadBrowse(scope, kind, 0);
      };

      // Scope change: clear selection and the check result, reload the list.
      // While a search is active the search is re-run against the new scope
      // instead of falling back to the plain list.
      const changeBrowseScope = (scope) => {
        if (sameBrowseScope(scope, browseScope)) return;
        setBrowseScope(scope);
        setBrowseSelected(null);
        setBrowseDetail(null);
        setBrowseDetailError("");
        setBrowseCheck(null);
        setBrowseOnlyMismatch(false);
        setBrowseConfirmForget(false);
        setBrowseList(null);
        if (browseSearchActive !== null) {
          runBrowseSearch(browseSearchActive, scope);
          return;
        }
        reloadBrowse(scope, browseKind, 0);
      };

      const loadMoreBrowse = () => {
        if (!browseList) return;
        reloadBrowse(browseScope, browseKind, browseList.items.length);
      };

      // Refresh: reload scopes + list (and the detail when a row is selected).
      // A manual refresh invalidates the last audit, so the check result and
      // the "only mismatched" filter are reset and the reader can re-run the
      // check. The selection survives only while its pairId is still listed
      // on the refreshed first page. While a search is active, Refresh re-runs
      // the active search (scopes are still reloaded) instead of the list.
      const refreshBrowse = async () => {
        const epoch = ++browseEpochRef.current;
        setBrowseError("");
        setBrowseBanner(null);
        if (browseSearchActive === null) setBrowseLoading(true);
        try {
          const scopesValue = await call("browse.scopes");
          if (epoch !== browseEpochRef.current) return;
          const scopes = Array.isArray(scopesValue && scopesValue.scopes) ? scopesValue.scopes : [];
          setBrowseScopes(scopes);
          const scope = fixupBrowseScope(browseScope, scopes, browseKind);
          if (!sameBrowseScope(scope, browseScope)) setBrowseScope(scope);
          if (browseSearchActive !== null) {
            await runBrowseSearch(browseSearchActive, scope);
            return;
          }
          setBrowseCheck(null);
          setBrowseOnlyMismatch(false);
          const value = await loadBrowseList(scope, browseKind, 0);
          if (epoch !== browseEpochRef.current) return;
          setBrowseList(value);
          if (browseSelected) {
            if (Array.isArray(value.items) && value.items.some((item) => item.pairId === browseSelected)) {
              await refreshSelectedDetail(browseSelected);
            } else {
              setBrowseSelected(null);
              setBrowseDetail(null);
              setBrowseDetailError("");
            }
          }
        } catch (err) {
          if (epoch !== browseEpochRef.current) return;
          setBrowseError(err.message);
          if (browseSearchActive !== null) setBrowseSearchError(err.message);
        } finally {
          if (epoch === browseEpochRef.current && browseSearchActive === null) setBrowseLoading(false);
        }
      };

      const refreshSelectedDetail = async (pairId) => {
        const epoch = browseDetailEpochRef.current;
        try {
          const detail = await call("browse.get", { pairId });
          if (epoch !== browseDetailEpochRef.current) return null;
          setBrowseDetail(detail);
          setBrowseDetailError("");
          return detail;
        } catch (err) {
          if (epoch !== browseDetailEpochRef.current) return null;
          setBrowseDetailError(err.message);
          return null;
        }
      };

      // Row click: fetch the detail. Orphan rows are never selectable.
      const selectBrowseRow = async (item) => {
        if (!item || (item.status && item.status.state === "orphan")) return;
        const epoch = ++browseDetailEpochRef.current;
        setBrowseSelected(item.pairId);
        setBrowseConfirmForget(false);
        setBrowseDetail(null);
        setBrowseDetailError("");
        setBrowseDetailLoading(true);
        try {
          const detail = await call("browse.get", { pairId: item.pairId });
          if (epoch !== browseDetailEpochRef.current) return;
          setBrowseDetail(detail);
        } catch (err) {
          if (epoch !== browseDetailEpochRef.current) return;
          if (err.code === "NOT_FOUND") {
            setBrowseDetailError(t("browseNotFound"));
            reloadBrowse(browseScope, browseKind, 0);
          } else {
            setBrowseDetailError(err.message);
          }
        } finally {
          if (epoch === browseDetailEpochRef.current) setBrowseDetailLoading(false);
        }
      };

      const runBrowseCheck = async () => {
        const epoch = browseEpochRef.current;
        setBrowseChecking(true);
        try {
          const value = await call("browse.check", { scope: browseScope });
          if (epoch !== browseEpochRef.current) return;
          setBrowseCheck(value);
        } catch (err) {
          if (epoch !== browseEpochRef.current) return;
          setBrowseBanner({ kind: "error", text: t("browseCheckError") + ": " + err.message });
        } finally {
          // The spinner belongs to this request only; stop it even when a
          // newer request invalidated the epoch and its result was dropped.
          setBrowseChecking(false);
        }
      };

      // Two-click confirmation; disarmed by leaving Browse or changing the
      // selection/scope/mode. Sends the full memory identity so the backend
      // can resolve the file even if the name collides across scopes.
      const forgetMemory = async () => {
        const detail = browseDetail;
        if (!detail) return;
        if (!browseConfirmForget) {
          setBrowseConfirmForget(true);
          return;
        }
        setBrowseConfirmForget(false);
        setBrowseBusy("forget");
        try {
          await call("browse.forget", {
            pairId: detail.pairId,
            memoryType: detail.memoryType,
            cwd: detail.cwd,
            name: detail.name,
            description: detail.description,
          });
          setBrowseBanner({ kind: "success", text: t("forgotten") });
          setBrowseSelected(null);
          setBrowseDetail(null);
          const scopesValue = await call("browse.scopes");
          const scopes = Array.isArray(scopesValue && scopesValue.scopes) ? scopesValue.scopes : [];
          setBrowseScopes(scopes);
          const scope = fixupBrowseScope(browseScope, scopes, browseKind);
          if (!sameBrowseScope(scope, browseScope)) setBrowseScope(scope);
          if (browseSearchActive !== null) {
            // Refresh the active search so scores and status stay current.
            await runBrowseSearch(browseSearchActive, scope);
          } else {
            await reloadBrowse(scope, browseKind, 0);
            // Keep the "only mismatched" view truthful after a repair.
            if (browseOnlyMismatch) await runBrowseCheck();
          }
        } catch (err) {
          setBrowseBanner({ kind: "error", text: err.message });
        } finally {
          setBrowseBusy("");
        }
      };

      const reindexEntry = async () => {
        const detail = browseDetail;
        if (!detail) return;
        setBrowseBusy("reindex");
        try {
          await call("browse.reindex", { pairId: detail.pairId });
          const fresh = await refreshSelectedDetail(detail.pairId);
          const state = fresh && fresh.status && fresh.status.state;
          setBrowseBanner({ kind: "success", text: state === "pending" ? t("reindexQueued") : t("reindexDone") });
          if (browseSearchActive !== null) {
            // Refresh the active search so scores and status stay current.
            await runBrowseSearch(browseSearchActive, browseScope);
          } else {
            await reloadBrowse(browseScope, browseKind, 0);
            // Keep the "only mismatched" view truthful after a repair.
            if (browseOnlyMismatch) await runBrowseCheck();
          }
        } catch (err) {
          setBrowseBanner({
            kind: "error",
            text: t("reindexFailed") + ": " + err.message,
          });
          // EMBEDDING_FAILED leaves the entry in the outbox: refetch the
          // detail so the pending status and outbox rows are shown.
          if (err.code === "EMBEDDING_FAILED") await refreshSelectedDetail(detail.pairId);
        } finally {
          setBrowseBusy("");
        }
      };

      const disabled = busy !== "";
      const config = (status && status.config) || {};
      const counts = (status && status.stats) || {};
      const runtime = (status && status.runtime) || {};
      const embed = config.embedding || {};
      const model = embed.model || t("unknown");
      const dim = counts.dim ?? t("unknown");

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
          numRow("minMessageLength", "retrieval.minMessageLength", { int: true, min: 0, max: 10000 }),
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

      // The strip stays visible on every tab, so the index counts remain at
      // hand while tuning retrieval settings or reading logs.
      const stripStat = (label, value) =>
        el("div", { className: "dscr-strip-stat" },
          el("span", { className: "dscr-strip-value" }, value),
          el("span", { className: "dscr-strip-label" }, label));

      const statusStrip = el("div", { className: "dscr-strip", "aria-label": t("statusTitle") },
        el("div", { className: "dscr-strip-stats" },
          stripStat(t("pairCount"), counts.pairCount ?? 0),
          stripStat(t("indexedCount"), counts.indexedCount ?? 0),
          stripStat(t("pendingCount"), counts.pendingCount ?? 0),
          stripStat(t("errorCount"), counts.errorCount ?? 0)),
        el("div", { className: "dscr-strip-meta" },
          el("span", { className: "dscr-pill" + (runtime.indexerRunning ? " dscr-pill-on" : "") },
            el("span", { className: "dscr-pill-dot", "aria-hidden": "true" }),
            t("indexer") + ": " + (runtime.indexerRunning ? t("running") : t("stopped"))),
          el("button", { className: "dscr-btn dscr-btn-small", type: "button", disabled, onClick: reload }, t("refresh"))));

      const dashboardCards = [
        el("div", { className: "dscr-card" },
          el("h2", { className: "dscr-title" }, t("statusTitle")),
          field(t("homePath"), config.home || t("none")),
          field(t("embedding"), model),
          field(t("dim"), dim),
          field(t("indexer"), runtime.indexerRunning ? t("running") : t("stopped")),
          field(t("initError"), runtime.initError || t("none")),
          field(t("lastError"), runtime.lastError || t("none"))),
        el("div", { className: "dscr-card" },
          el("h2", { className: "dscr-title" }, t("indexOpsTitle")),
          field(t("indexFiles"), counts.pairFiles ?? 0),
          field(t("indexSize"), formatBytes(counts.indexBytes, t)),
          el("p", { className: "dscr-help" }, t("indexOpsHelp")),
          el("div", { className: "dscr-btns" },
            btn(t("rebuild"), rebuild),
            btn(t(confirmClear ? "confirmClear" : "clear"), clear))),
      ];

      const advancedCard = el("details", {
        className: "dscr-card dscr-details",
        open: advancedOpen,
        onToggle: (e) => setAdvancedOpen(e.currentTarget.open),
      },
        el("summary", { className: "dscr-title dscr-summary" }, t("advancedTitle")),
        el("textarea", { className: "dscr-textarea", value: configText, spellCheck: false, "aria-label": t("advancedTitle"), onChange: (e) => setConfigText(e.target.value) }),
        el("p", { className: "dscr-help" }, t("configHelp")));

      const actionsCard = el("div", { className: "dscr-card" },
        el("h2", { className: "dscr-title" }, t("actionsTitle")),
        el("div", { className: "dscr-btns" },
          btn(t("reload"), reload), btn(t("save"), save),
          btn(t("testEmbedding"), () => test("connection.testEmbedding")),
          btn(t("testRerank"), () => test("connection.testRerank")),
          dirty ? el("span", { className: "dscr-unsaved" }, t("unsaved")) : null));

      const configurationCards = [...settingsCards, advancedCard, actionsCard];

      const logRow = (entry, i) => {
        const level = entry && entry.level;
        const levelClass = "dscr-log-level" + (level === "error" ? " dscr-log-level-error" : level === "warn" ? " dscr-log-level-warn" : "");
        return el("div", { key: i, className: "dscr-log-row" },
          el("span", { className: "dscr-log-time" }, new Date(entry.time).toLocaleString()),
          el("span", { className: levelClass }, level || ""),
          el("span", { className: "dscr-log-message" }, entry.message || ""));
      };

      const logBusyActive = logBusy !== "";
      const logLimitPending = logLimitText.trim() !== "" && Number(logLimitText) !== logLimit;
      const logsCards = [
        el("div", { className: "dscr-card" },
          el("h2", { className: "dscr-title" }, t("logsTitle")),
          el("p", { className: "dscr-help" }, t("logsHelp")),
          el("div", { className: "dscr-log-controls" },
            el("div", { className: "dscr-log-control" },
              el("label", { htmlFor: "dscr-log-limit" }, t("logLimit")),
              el("input", {
                id: "dscr-log-limit",
                className: "dscr-input",
                type: "number",
                min: 1, max: 5000, step: 1,
                value: logLimitText,
                disabled: logBusyActive,
                onChange: (e) => { logLimitEditedRef.current = true; setLogLimitText(e.target.value); },
                onKeyDown: (e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    applyLimit();
                  }
                },
              }),
              el("button", { className: "dscr-btn", type: "button", disabled: logBusyActive, onClick: applyLimit }, t("logApply"))),
            el("div", { className: "dscr-log-control" },
              el("input", { id: "dscr-log-debug", type: "checkbox", checked: !!logDebug, disabled: logBusyActive, onChange: (e) => toggleDebug(e.target.checked) }),
              el("label", { htmlFor: "dscr-log-debug" }, t("logDebug"))),
            el("div", { className: "dscr-log-control" },
              el("button", { className: "dscr-btn", type: "button", disabled: logBusyActive, onClick: refreshLogs }, t("logRefresh")),
              el("button", { className: "dscr-btn", type: "button", disabled: logBusyActive, onClick: exportLogs }, t("logExport")))),
          el("p", { className: "dscr-log-count" },
            logEntries.length + " / " + logLimit + " " + t("logCount"),
            logLimitPending ? el("span", { className: "dscr-log-pending" }, " · " + t("logLimitPending")) : null),
          logError ? el("p", { className: "dscr-log-error", role: "status" }, t("logPollError") + ": " + logError) : null,
          logEntries.length === 0
            ? el("p", { className: "dscr-help" }, t("logEmpty"))
            : el("div", { className: "dscr-log-list", role: "log", "aria-live": "off", "aria-label": t("logsLabel"), ref: logListRef, tabIndex: 0, onScroll: (e) => {
                const node = e.currentTarget;
                logFollowRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
              } },
                ...logEntries.map(logRow))),
      ];

      // ------------------------------------------------------------------
      // Browse tab render
      // ------------------------------------------------------------------

      // Counts for the mode buttons come from browse.scopes for the current
      // scope ({memories, pairs}).
      const scopeInfo = browseScopes.find((s) => sameBrowseScope(s, browseScope)) || { memories: 0, pairs: 0 };
      const scopeLabelText = (s) => {
        if (s.label) return s.label;
        if (s.labelKey) {
          const translated = t(s.labelKey);
          if (translated && translated !== s.labelKey) return translated;
        }
        const name = browseBasename(s.cwd);
        if (s.type === "workspace" && !name) return t("browseWorkspaceUnavailable");
        return name;
      };
      const statusPill = (status) =>
        el("span", { className: statusClass(status && status.state) }, t(statusKey(status && status.state)));
      const memoryBadge = (memoryType) =>
        el("span", { className: "dscr-browse-badge" },
          memoryType === "global" ? t("globalLabel") : t("workspaceLabel"));

      const memoryRow = (item) => {
        const orphan = item.status && item.status.state === "orphan";
        const selected = browseSelected === item.pairId;
        return el("button", {
          key: item.pairId,
          className: "dscr-browse-row" + (selected ? " dscr-browse-row-selected" : ""),
          type: "button",
          disabled: orphan,
          "aria-current": selected ? "true" : undefined,
          onClick: () => selectBrowseRow(item),
        },
          el("span", { className: "dscr-browse-row-head" },
            el("span", { className: "dscr-browse-row-main" }, item.name),
            statusPill(item.status)),
          el("span", { className: "dscr-browse-row-sub" },
            memoryBadge(item.memoryType),
            el("span", { className: "dscr-browse-row-desc" }, item.description || ""),
            el("span", { className: "dscr-browse-row-date" }, browseDate(item.createdAt))));
      };

      const pairRow = (item) => {
        const orphan = item.status && item.status.state === "orphan";
        const selected = browseSelected === item.pairId;
        const metaParts = [];
        if (item.cwd) metaParts.push(browseBasename(item.cwd));
        if (item.sessionId) metaParts.push(String(item.sessionId).slice(-8));
        if (item.turn !== undefined && item.turn !== null) metaParts.push(t("browseMetaTurn") + " " + item.turn);
        return el("button", {
          key: item.pairId,
          className: "dscr-browse-row" + (selected ? " dscr-browse-row-selected" : ""),
          type: "button",
          disabled: orphan,
          "aria-current": selected ? "true" : undefined,
          onClick: () => selectBrowseRow(item),
        },
          el("span", { className: "dscr-browse-row-head" },
            el("span", { className: "dscr-browse-row-main" }, item.preview || ""),
            statusPill(item.status)),
          el("span", { className: "dscr-browse-row-sub" },
            el("span", { className: "dscr-browse-row-meta" }, metaParts.join(" · ")),
            el("span", { className: "dscr-browse-row-date" }, browseDate(item.createdAt))));
      };

      const visibleItems = browseOnlyMismatch && browseCheck
        ? (Array.isArray(browseCheck.mismatches) ? browseCheck.mismatches : []).filter((item) => item.kind === browseKind)
        : (browseList && Array.isArray(browseList.items) ? browseList.items : []);

      const browseMore = !browseOnlyMismatch && browseList && browseList.items.length < browseList.total
        ? el("button", {
            key: "__browse-more",
            className: "dscr-btn dscr-browse-more",
            type: "button",
            disabled: browseLoading || browseBusy !== "",
            onClick: loadMoreBrowse,
          }, t("browseLoadMore"))
        : null;

      // Manual search controls: one form above the toolbar. Enter submits via
      // the form; the Search button is its submit button; Clear appears while
      // a search is active or the input is non-empty.
      const searchForm = el("form", {
        className: "dscr-browse-search",
        role: "search",
        onSubmit: submitBrowseSearch,
      },
        el("input", {
          className: "dscr-input dscr-browse-search-input",
          "aria-label": t("browseSearchPlaceholder"),
          placeholder: t("browseSearchPlaceholder"),
          value: browseSearchQuery,
          onChange: (e) => setBrowseSearchQuery(e.target.value),
        }),
        el("button", {
          className: "dscr-btn",
          type: "submit",
          disabled: browseSearching,
        }, t("browseSearch")),
        browseSearchActive !== null || browseSearchQuery.trim() !== ""
          ? el("button", {
              className: "dscr-btn",
              type: "button",
              onClick: clearBrowseSearch,
            }, t("browseClearSearch"))
          : null);

      // Mixed results list shown while a search is active, replacing the
      // normal browse list. Each row reuses the browse row look and adds a
      // kind badge plus a score pill (final score to 3 decimals with a small
      // cosine/rerank marker).
      const searchScorePill = (item) =>
        Number.isFinite(item.score)
          ? el("span", { className: "dscr-browse-search-pill dscr-browse-search-score" },
              t("browseSearchScore") + " " + Number(item.score).toFixed(3),
              " · ",
              el("span", { className: "dscr-browse-search-marker" }, item.reranked ? t("browseSearchReranked") : t("browseSearchCosine")))
          : null;

      const searchRow = (item) => {
        const orphan = item.status && item.status.state === "orphan";
        const selected = browseSelected === item.pairId;
        const isMemory = item.kind === "memory";
        const metaParts = [];
        if (!isMemory) {
          if (item.cwd) metaParts.push(browseBasename(item.cwd));
          if (item.sessionId) metaParts.push(String(item.sessionId).slice(-8));
          if (item.turn !== undefined && item.turn !== null) metaParts.push(t("browseMetaTurn") + " " + item.turn);
        }
        return el("button", {
          key: item.pairId,
          className: "dscr-browse-row" + (selected ? " dscr-browse-row-selected" : ""),
          type: "button",
          disabled: orphan,
          "aria-current": selected ? "true" : undefined,
          onClick: () => selectBrowseRow(item),
        },
          // The title gets a full line of its own so the badges cannot squeeze
          // it; the badges wrap on a separate line below.
          el("span", { className: "dscr-browse-row-head" },
            el("span", { className: "dscr-browse-row-main" }, isMemory ? (item.name || "") : (item.preview || ""))),
          el("span", { className: "dscr-browse-row-badges" },
            el("span", { className: "dscr-browse-search-kind" }, isMemory ? t("browseMemories") : t("browsePairs")),
            searchScorePill(item),
            statusPill(item.status),
            isMemory ? memoryBadge(item.memoryType) : null),
          el("span", { className: "dscr-browse-row-sub" },
            isMemory
              ? el("span", { className: "dscr-browse-row-desc" }, item.description || "")
              : el("span", { className: "dscr-browse-row-meta" }, metaParts.join(" · ")),
            el("span", { className: "dscr-browse-row-date" }, browseDate(item.createdAt))));
      };

      const searchResults = Array.isArray(browseSearchResult && browseSearchResult.results) ? browseSearchResult.results : [];
      const searchStats = browseSearchResult && browseSearchResult.stats;
      const rerankUsed = !!(searchStats && searchStats.reranked);
      const rerankFallback = searchStats && searchStats.rerankError;

      const searchStatusLine = browseSearchResult && !browseSearchError
        ? el("div", { className: "dscr-browse-search-status", role: "status" },
            t("browseSearchStatusLine") + ": " + browseSearchActive + " · " + searchResults.length + " " + t("browseSearchResults"),
            " · " + (rerankUsed ? t("browseSearchReranked") : t("browseSearchCosine")),
            rerankFallback ? el("span", { className: "dscr-browse-search-fallback" }, " · " + t("browseSearchRerankFallback")) : null)
        : null;

      let listBody;
      if (browseSearchActive !== null) {
        if (browseSearchError) {
          listBody = el("p", { className: "dscr-browse-error", role: "status" }, t("browseSearchFailed") + ": " + browseSearchError);
        } else if (browseSearching && searchResults.length === 0) {
          listBody = el("p", { className: "dscr-browse-empty", role: "status" }, t("browseSearching"));
        } else if (searchResults.length === 0) {
          listBody = el("p", { className: "dscr-browse-empty", role: "status" }, t("browseSearchEmpty"));
        } else {
          listBody = el("div", { className: "dscr-browse-list-scroll", role: "list", "aria-label": t("browseListLabel"), tabIndex: 0 },
            ...searchResults.map(searchRow));
        }
      } else {
        listBody = browseLoading && !browseList && !browseOnlyMismatch
          ? el("p", { className: "dscr-browse-empty", role: "status" }, t("browseLoading"))
          : browseError && !browseOnlyMismatch
          ? el("p", { className: "dscr-browse-error", role: "status" }, t("browseLoadError") + ": " + browseError)
          : visibleItems.length === 0
          ? el("p", { className: "dscr-browse-empty" },
              browseOnlyMismatch ? t("browseEmptyMismatch") : t(browseKind === "memories" ? "browseEmptyMemories" : "browseEmptyPairs"))
          : el("div", { className: "dscr-browse-list-scroll", role: "list", "aria-label": t("browseListLabel"), tabIndex: 0 },
              ...visibleItems.map(browseKind === "memories" ? memoryRow : pairRow),
              browseMore);
      }

      const listPanel = el("div", { className: "dscr-browse-list", role: "region", "aria-label": t("browseListLabel") },
        el("h3", { className: "dscr-browse-panel-title" }, t("browseListLabel")),
        searchStatusLine,
        listBody);

      const detailMetaRow = (label, value) =>
        el("div", { className: "dscr-browse-meta-row" },
          el("span", { className: "dscr-browse-meta-label" }, label),
          el("span", { className: "dscr-browse-meta-value" }, value == null ? "" : value));

      const outboxRow = (outbox) => {
        const parts = [
          t("browseMetaReason") + ": " + (outbox.reason || t("none")),
          t("browseMetaAttempts") + ": " + (outbox.attempts ?? 0),
        ];
        if (outbox.lastError) parts.push(t("browseMetaLastError") + ": " + outbox.lastError);
        return parts.join(" · ");
      };

      let detailBody;
      if (browseDetailLoading) {
        detailBody = el("p", { className: "dscr-browse-empty", role: "status" }, t("browseLoading"));
      } else if (browseDetailError) {
        detailBody = el("p", { className: "dscr-browse-error", role: "status" }, browseDetailError);
      } else if (!browseSelected || !browseDetail) {
        detailBody = el("p", { className: "dscr-browse-empty" }, t("browseSelectHint"));
      } else {
        const detail = browseDetail;
        const isMemory = detail.kind === "memory";
        const status = detail.status || {};
        const metaRows = [
          ...(isMemory
            ? [
                detailMetaRow(t("browseMetaName"), detail.name),
                detailMetaRow(t("browseMetaDescription"), detail.description),
                detailMetaRow(t("browseMetaType"), detail.memoryType === "global" ? t("globalLabel") : t("workspaceLabel")),
                detailMetaRow(t("browseMetaCwd"), detail.cwd || t("none")),
                detailMetaRow(t("browseMetaCreatedAt"), browseDate(detail.createdAt)),
              ]
            : [
                detailMetaRow(t("browseMetaPairId"), detail.pairId),
                detailMetaRow(t("browseMetaSessionId"), detail.sessionId),
                detailMetaRow(t("browseMetaCwd"), detail.cwd),
                detailMetaRow(t("browseMetaTurn"), detail.turn),
                detailMetaRow(t("browseMetaCreatedAt"), browseDate(detail.createdAt)),
              ]),
          detailMetaRow(t("browseMetaStatus"), statusPill(status)),
          ...(status.model !== undefined && status.model !== null ? [detailMetaRow(t("browseMetaModel"), status.model)] : []),
          ...(status.dim !== undefined && status.dim !== null ? [detailMetaRow(t("browseMetaDim"), status.dim)] : []),
          ...(status.indexedAt ? [detailMetaRow(t("browseMetaIndexedAt"), browseDate(status.indexedAt))] : []),
          ...(status.state === "pending" && detail.outbox
            ? [detailMetaRow(t("browseMetaOutbox"), outboxRow(detail.outbox))]
            : []),
        ];
        const contentBlocks = isMemory
          ? [
              el("h3", { className: "dscr-browse-section" }, t("memoryContent")),
              el("pre", { className: "dscr-browse-content" }, detail.content || ""),
              detail.contentTruncated ? el("p", { className: "dscr-browse-note" }, t("contentTruncated")) : null,
            ]
          : [
              el("h3", { className: "dscr-browse-section" }, t("userMessage")),
              el("pre", { className: "dscr-browse-content" }, detail.user || ""),
              detail.userTruncated ? el("p", { className: "dscr-browse-note" }, t("contentTruncated")) : null,
              el("h3", { className: "dscr-browse-section" }, t("assistantMessage")),
              el("pre", { className: "dscr-browse-content" }, detail.assistant || ""),
              detail.assistantTruncated ? el("p", { className: "dscr-browse-note" }, t("contentTruncated")) : null,
            ];
        // Re-index applies to any non-consistent, non-orphan entry. Orphan
        // rows are not selectable at all, so they never reach this point.
        const canReindex = !(status.state === "consistent" || status.state === "orphan");
        // Re-index needs an active embedding client: a configured model and
        // the embedding switch enabled. Otherwise the backend answers
        // EMBEDDING_DISABLED, so disable it up front with a hint.
        const embeddingMissing = !embed.model || embed.enabled === false;
        detailBody = el("div", { className: "dscr-browse-detail-body" },
          el("div", { className: "dscr-browse-meta" }, ...metaRows),
          el("div", { className: "dscr-browse-actions" },
            isMemory
              ? el("button", {
                  className: "dscr-btn",
                  type: "button",
                  disabled: browseBusy !== "",
                  onClick: forgetMemory,
                }, t(browseConfirmForget ? "confirmForget" : "forget"))
              : null,
            canReindex
              ? el("button", {
                  className: "dscr-btn",
                  type: "button",
                  disabled: browseBusy !== "" || embeddingMissing,
                  onClick: reindexEntry,
                }, t("reindex"))
              : null,
            canReindex && embeddingMissing
              ? el("span", { className: "dscr-browse-note" }, t("browseEmbeddingDisabled"))
              : null),
          ...contentBlocks);
      }

      const detailPanel = el("div", { className: "dscr-browse-detail", role: "region", "aria-label": t("browseDetailLabel") },
        el("h3", { className: "dscr-browse-panel-title" }, t("browseDetailLabel")),
        detailBody);

      const checkMismatches = browseCheck
        ? Object.entries(browseCheck.counts || {}).filter(([, n]) => Number(n) > 0)
        : [];
      const checkLine = browseCheck
        ? el("div", { className: "dscr-browse-checkline", role: "status" },
            el("span", { className: "dscr-browse-check-title" }, t("checkSummary") + ":"),
            " " + t("browsePairs") + " " + ((browseCheck.checked && browseCheck.checked.pairs) || 0)
              + " · " + t("memoryCount") + " " + ((browseCheck.checked && browseCheck.checked.memories) || 0)
              + " · " + t("browseCounts") + " " + ((browseCheck.checked && browseCheck.checked.total) || 0),
            checkMismatches.length > 0
              ? el("span", { className: "dscr-browse-check-mismatches" },
                  " — " + checkMismatches.map(([state, n]) => t(countStatusKey(state)) + " " + n).join(", "))
              : el("span", null, " — " + t("checkNoMismatch")),
            browseCheck.truncated ? el("span", { className: "dscr-browse-note" }, " · " + t("checkTruncated")) : null)
        : null;

      const browseToolbar = el("div", { className: "dscr-browse-toolbar" },
        el("div", { className: "dscr-browse-mode", role: "group", "aria-label": t("browseModeLabel") },
          el("button", {
            key: "memories",
            className: "dscr-browse-mode-btn" + (browseKind === "memories" ? " dscr-browse-mode-active" : ""),
            type: "button",
            "aria-pressed": browseKind === "memories",
            // The search is mixed, so the mode toggle is disabled while one is
            // active; clearing the search re-enables it.
            disabled: browseLoading || browseBusy !== "" || browseSearchActive !== null,
            onClick: () => switchBrowseKind("memories"),
          }, t("browseMemories") + " (" + (scopeInfo.memories ?? 0) + ")"),
          el("button", {
            key: "pairs",
            className: "dscr-browse-mode-btn" + (browseKind === "pairs" ? " dscr-browse-mode-active" : ""),
            type: "button",
            "aria-pressed": browseKind === "pairs",
            disabled: browseLoading || browseBusy !== "" || browseSearchActive !== null,
            onClick: () => switchBrowseKind("pairs"),
          }, t("browsePairs") + " (" + (scopeInfo.pairs ?? 0) + ")")),
        el("select", {
          className: "dscr-input dscr-browse-scope",
          value: scopeSelectValue(browseScope),
          disabled: browseLoading || browseBusy !== "",
          onChange: (e) => {
            const v = e.target.value;
            if (v === "all") changeBrowseScope({ type: "all" });
            else if (v === "global") changeBrowseScope({ type: "global" });
            else changeBrowseScope({ type: "workspace", cwd: v.slice("workspace:".length) });
          },
        },
          el("option", { key: "all", value: "all" }, t("scopeAll")),
          browseKind === "memories"
            ? el("option", { key: "global", value: "global" }, t("browseScopeGlobal"))
            : null,
          ...browseScopes.filter((s) => s.type === "workspace").map((s) =>
            el("option", { key: scopeSelectValue(s), value: scopeSelectValue(s) }, scopeLabelText(s)))),
        el("button", {
          className: "dscr-btn",
          type: "button",
          disabled: browseChecking || browseBusy !== "",
          onClick: () => {
            // A user-initiated check replaces any older banner; checks run
            // after a repair keep the repair's success message.
            setBrowseBanner(null);
            runBrowseCheck();
          },
        }, t(browseChecking ? "checkingIndex" : "checkIndex")),
        el("button", {
          className: "dscr-btn",
          type: "button",
          disabled: browseLoading || browseBusy !== "",
          onClick: refreshBrowse,
        }, t("refresh")),
        el("label", { className: "dscr-browse-toggle" },
          el("input", {
            type: "checkbox",
            checked: browseOnlyMismatch,
            disabled: !browseCheck || browseChecking || browseBusy !== "",
            onChange: (e) => {
              const checked = e.target.checked;
              // Enabling the filter exits any active search: the mismatch list
              // replaces the mixed search results.
              if (checked) clearBrowseSearch();
              setBrowseOnlyMismatch(checked);
            },
          }),
          " " + t("onlyMismatched")));

      const browseBannerNode = browseBanner
        ? el("div", { className: "dscr-banner" + (browseBanner.kind === "error" ? " dscr-banner-error" : ""), role: "status", "aria-live": "polite" },
            el("strong", null, browseBanner.kind === "error" ? t("error") : t("ok")),
            " " + browseBanner.text)
        : null;

      const browseCards = [
        el("div", { className: "dscr-card" },
          el("h2", { className: "dscr-title" }, t("browseTab")),
          el("p", { className: "dscr-help" }, t("browseHelp")),
          searchForm,
          browseToolbar,
          checkLine,
          browseBannerNode,
          el("div", { className: "dscr-browse-split" }, listPanel, detailPanel)),
      ];

      const panel = (id, children, selected) => el("div", {
        id: panelDomId(id),
        className: "dscr-panel",
        role: "tabpanel",
        "aria-labelledby": tabDomId(id),
        tabIndex: selected ? 0 : undefined,
        hidden: !selected,
      }, ...children);

      const tabs = [
        { id: "dashboard", labelKey: "dashboardTab", content: dashboardCards },
        { id: "browse", labelKey: "browseTab", content: browseCards },
        { id: "configuration", labelKey: "configurationTab", dirty, content: configurationCards },
        { id: "logs", labelKey: "logsTab", content: logsCards },
      ];
      const currentTab = tabs.find((tab) => tab.id === activeTab) || tabs[0];

      return el("div", { className: "dscr-page" },
        statusStrip,
        el(TabBar, { tabs, active: currentTab.id, onChange: selectTab, t }),
        ...tabs.map((tab) => panel(tab.id, tab.content, tab.id === currentTab.id)),
        busy ? el("div", { className: "dscr-busy", role: "status", "aria-live": "polite" }, t("busy") + " " + busy) : null,
        bannerNode);
    }

    // ------------------------------------------------------------------
    // plugin
    // ------------------------------------------------------------------

    const messages = {
      en: {
        title: "Context RAG",
        dashboardTab: "Dashboard", configurationTab: "Configuration", tabsLabel: "Sections",
        statusTitle: "Status", indexOpsTitle: "Index maintenance", actionsTitle: "Actions",
        indexFiles: "Index files", indexSize: "Index size",
        unitB: "B", unitKB: "KB", unitMB: "MB", unitGB: "GB",
        indexOpsHelp: "Rebuild re-embeds every stored pair from the JSONL log. Clear removes index rows and the pending outbox but keeps the pair log.",
        unsaved: "Unsaved changes", refresh: "Refresh",
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
        allowSameSession: "Allow same-session recall", dedupeTurns: "Dedupe turns", minMessageLength: "Min message length",
        dedupeStateRetentionDays: "Recall-state retention (days)", dedupeStateMaxSessions: "Recall-state max sessions",
        candidateLimit: "Candidate limit", topK: "Top K", minScore: "Min cosine score", rerankMinScore: "Min rerank score", maxContextChars: "Max context chars",
        dedupeHelp: "Dedupe turns: 5 default; 0 disables turn dedupe; -1 allows each candidate (pair or memory) only once per session. Successful memory writes count as a recall at the current turn. Retention values of 0 disable that limit. Min message length: shorter messages are skipped for recall and not stored; 0 disables the limit. Length counts each Han character as 1 and a run of Latin letters/digits as one word; punctuation is ignored.",
        indexingEnabled: "Indexing enabled", pollIntervalMs: "Poll interval (ms)", retryDelayMs: "Retry delay (ms)", maxAttempts: "Max attempts",
        configHelp: "Edit the JSON directly. API keys are write-only: add a string \"apiKey\" field (e.g. embedding.apiKey) to set one; it is sent to the server and never shown again (apiKeySet / apiKeyPreview only indicate whether a key is set).",
        reload: "Reload", save: "Save", testEmbedding: "Test embedding", testRerank: "Test rerank",
        rebuild: "Rebuild index", clear: "Clear index", confirmClear: "Click again to confirm",
        saved: "Configuration saved.", cleared: "Index cleared.", rebuilt: "Index rebuilt.",
        testOk: "Connection OK", jsonInvalid: "Invalid JSON", busy: "Busy", ok: "OK", error: "Error",
        logsTab: "Logs", logsTitle: "Plugin logs",
        logsHelp: "Logs live in memory only: the ring buffer keeps the latest N entries, refreshes every 2 seconds while this tab is active, and nothing is written to disk by default. Click \"Write to disk\" to export the current window to <home>/logs/.",
        logLimit: "Keep latest", logApply: "Apply", logDebug: "Capture debug logs",
        logRefresh: "Refresh logs", logExport: "Write to disk",
        logExportOk: "Logs written:", logConfigured: "Log settings applied.",
        logLimitInvalid: "N must be an integer between 1 and 5000.",
        logLimitPending: "not applied yet",
        logEmpty: "No log entries in the current window. Enable debug capture to collect more detail.",
        logCount: "entries", logPollError: "Auto refresh failed", logsLabel: "Log entries",
        // Browse tab
        browseTab: "Browse",
        browseHelp: "Browse or search the stored memories and message pairs by meaning, inspect their index status, check index consistency, re-index a single entry, or forget a memory.",
        browseMemories: "Memories", browsePairs: "Pairs",
        browseModeLabel: "Data set",
        browseScopeGlobal: "Global",
        browseListLabel: "Entries", browseDetailLabel: "Details",
        browseSelectHint: "Select an entry to see its details.",
        browseLoadMore: "Load more", browseLoading: "Loading…",
        browseEmptyMemories: "No memories in this scope.",
        browseEmptyPairs: "No message pairs in this scope.",
        browseEmptyMismatch: "No mismatched entries.",
        checkIndex: "Check index", checkingIndex: "Checking…",
        onlyMismatched: "Only mismatched",
        checkSummary: "Index check",
        checkTruncated: "Check truncated — too many mismatches to list.",
        checkNoMismatch: "No mismatches found.",
        memoryCount: "Memories", browseCounts: "Total",
        statusConsistent: "Consistent", statusMissing: "Missing", statusStale: "Stale text",
        statusPending: "Pending", statusModel: "Model mismatch", statusCorrupt: "Corrupt",
        statusOrphan: "Index residue", statusUnknown: "Unknown",
        reindex: "Re-index", reindexDone: "Re-indexed.",
        reindexQueued: "Queued for re-indexing.", reindexFailed: "Re-index failed",
        forget: "Forget", confirmForget: "Click again to confirm",
        forgotten: "Memory forgotten.",
        memoryContent: "Content", userMessage: "User message", assistantMessage: "Assistant reply",
        contentTruncated: "Content too long — truncated.",
        browseLoadError: "Failed to load entries",
        browseNotFound: "This entry no longer exists — the list has been refreshed.",
        browseCheckError: "Index check failed",
        browseMetaName: "Name", browseMetaDescription: "Description", browseMetaType: "Type",
        browseMetaCwd: "Workspace", browseMetaCreatedAt: "Created",
        browseMetaStatus: "Status", browseMetaModel: "Model", browseMetaDim: "Dimensions",
        browseMetaIndexedAt: "Indexed at",
        browseMetaPairId: "Pair ID", browseMetaSessionId: "Session ID", browseMetaTurn: "Turn",
        browseMetaOutbox: "Outbox",
        browseMetaReason: "Reason", browseMetaAttempts: "Attempts", browseMetaLastError: "Last error",
        globalLabel: "Global", workspaceLabel: "Workspace",
        browseWorkspaceUnavailable: "Workspace unavailable",
        browseEmbeddingDisabled: "Embedding is disabled or no embedding model is configured — re-index is disabled.",
        // Manual search over memories + message pairs
        browseSearchPlaceholder: "Search memories and message pairs…",
        browseSearch: "Search",
        browseSearching: "Searching…",
        browseClearSearch: "Clear",
        browseSearchResults: "results",
        browseSearchEmpty: "No matching entries.",
        browseSearchFailed: "Search failed",
        browseSearchReranked: "Rerank",
        browseSearchCosine: "cosine",
        browseSearchScore: "Score",
        browseSearchStatusLine: "Search results",
        browseSearchRerankFallback: "Rerank unavailable — cosine scores shown",
      },
      zh: {
        title: "Context RAG",
        dashboardTab: "仪表盘", configurationTab: "配置", tabsLabel: "分区",
        statusTitle: "状态", indexOpsTitle: "索引维护", actionsTitle: "操作",
        indexFiles: "索引文件数", indexSize: "索引体积",
        unitB: "B", unitKB: "KB", unitMB: "MB", unitGB: "GB",
        indexOpsHelp: "重建会从 JSONL 日志重新嵌入所有已存条目。清空会删除索引记录和待处理队列，但保留条目日志。",
        unsaved: "有未保存的修改", refresh: "刷新",
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
        allowSameSession: "允许同会话召回", dedupeTurns: "去重轮次", minMessageLength: "最小消息长度",
        dedupeStateRetentionDays: "召回状态保留天数", dedupeStateMaxSessions: "召回状态最大会话数",
        candidateLimit: "候选数量", topK: "最终条数", minScore: "余弦最低分", rerankMinScore: "重排最低分", maxContextChars: "上下文字符上限",
        dedupeHelp: "去重轮次：默认 5；设为 0 禁用轮次去重；设为 -1 表示每条记录（历史对话或记忆）在每个会话中仅召回一次。成功写入记忆也会按当前轮次计为一次召回。保留值为 0 表示不限制。最小消息长度：短于阈值的消息跳过召回且不存储；设为 0 禁用该限制。长度统计时每个汉字计为 1，连续的拉丁字母/数字计为一个词，标点忽略。",
        indexingEnabled: "启用索引", pollIntervalMs: "轮询间隔（毫秒）", retryDelayMs: "重试延迟（毫秒）", maxAttempts: "最大尝试次数",
        configHelp: "直接编辑 JSON。API 密钥为只写：添加字符串字段 \"apiKey\"（如 embedding.apiKey）即可设置；密钥只发送给服务器、永不显示（仅通过 apiKeySet / apiKeyPreview 表明是否已设置）。",
        reload: "重新加载", save: "保存", testEmbedding: "测试嵌入", testRerank: "测试重排",
        rebuild: "重建索引", clear: "清空索引", confirmClear: "再次点击确认",
        saved: "配置已保存。", cleared: "索引已清空。", rebuilt: "索引已重建。",
        testOk: "连接成功", jsonInvalid: "JSON 无效", busy: "处理中", ok: "成功", error: "错误",
        logsTab: "日志", logsTitle: "插件日志",
        logsHelp: "日志只保存在内存：环形缓冲保留最新 N 条，本标签页激活时每 2 秒自动刷新，默认不写盘。点击“写入磁盘”才会把当前窗口导出到 <home>/logs/。",
        logLimit: "保留最新", logApply: "应用", logDebug: "采集调试日志",
        logRefresh: "刷新日志", logExport: "写入磁盘",
        logExportOk: "日志已写入：", logConfigured: "日志设置已应用。",
        logLimitInvalid: "N 必须是 1 到 5000 的整数。",
        logLimitPending: "尚未应用",
        logEmpty: "当前窗口内没有日志。开启调试日志可采集更多细节。",
        logCount: "条目", logPollError: "自动刷新失败", logsLabel: "日志条目",
        // Browse tab
        browseTab: "浏览",
        browseHelp: "浏览或按语义搜索已保存的记忆与消息条目，查看索引状态，检查索引一致性，重新索引单条记录，或遗忘记忆。",
        browseMemories: "记忆", browsePairs: "消息",
        browseModeLabel: "数据集",
        browseScopeGlobal: "全局",
        browseListLabel: "条目列表", browseDetailLabel: "详情",
        browseSelectHint: "选择条目查看详情。",
        browseLoadMore: "加载更多", browseLoading: "加载中…",
        browseEmptyMemories: "该范围内没有记忆。",
        browseEmptyPairs: "该范围内没有消息条目。",
        browseEmptyMismatch: "没有不一致的条目。",
        checkIndex: "检查索引", checkingIndex: "检查中…",
        onlyMismatched: "仅显示不一致",
        checkSummary: "索引检查",
        checkTruncated: "检查结果已截断——不一致条目过多。",
        checkNoMismatch: "未发现不一致条目。",
        memoryCount: "记忆", browseCounts: "总计",
        statusConsistent: "一致", statusMissing: "缺失", statusStale: "文本过期",
        statusPending: "待处理", statusModel: "模型不匹配", statusCorrupt: "损坏",
        statusOrphan: "索引残留", statusUnknown: "未知",
        reindex: "重新索引", reindexDone: "已重新索引。",
        reindexQueued: "已加入重新索引队列。", reindexFailed: "重新索引失败",
        forget: "遗忘", confirmForget: "再次点击确认",
        forgotten: "记忆已遗忘。",
        memoryContent: "内容", userMessage: "用户消息", assistantMessage: "助手回复",
        contentTruncated: "内容过长——已截断。",
        browseLoadError: "加载条目失败",
        browseNotFound: "该条目已不存在——列表已刷新。",
        browseCheckError: "索引检查失败",
        browseMetaName: "名称", browseMetaDescription: "描述", browseMetaType: "类型",
        browseMetaCwd: "工作区", browseMetaCreatedAt: "创建时间",
        browseMetaStatus: "状态", browseMetaModel: "模型", browseMetaDim: "维度",
        browseMetaIndexedAt: "索引时间",
        browseMetaPairId: "条目 ID", browseMetaSessionId: "会话 ID", browseMetaTurn: "轮次",
        browseMetaOutbox: "待处理队列",
        browseMetaReason: "原因", browseMetaAttempts: "尝试次数", browseMetaLastError: "最近错误",
        globalLabel: "全局", workspaceLabel: "工作区",
        browseWorkspaceUnavailable: "工作区不可用",
        browseEmbeddingDisabled: "嵌入未启用或未配置嵌入模型——无法重新索引。",
        // Manual search over memories + message pairs
        browseSearchPlaceholder: "搜索记忆与消息条目…",
        browseSearch: "搜索",
        browseSearching: "搜索中…",
        browseClearSearch: "清除",
        browseSearchResults: "个结果",
        browseSearchEmpty: "没有匹配的条目。",
        browseSearchFailed: "搜索失败",
        browseSearchReranked: "重排",
        browseSearchCosine: "余弦",
        browseSearchScore: "得分",
        browseSearchStatusLine: "搜索结果",
        browseSearchRerankFallback: "重排不可用——已显示余弦得分",
      },
    };

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement("style");
          style.id = "dsh-context-rag-styles";
          style.textContent = [
            ".dscr-page { width: 100%; max-width: 840px; box-sizing: border-box; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; padding: 16px; }",
            ".dscr-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); padding: 16px; color: var(--dsw-alias-label-primary, inherit); } .dscr-title { font-size: 16px; font-weight: 600; margin: 0 0 12px; color: var(--dsw-alias-label-primary, inherit); }",
            ".dscr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin-bottom: 12px; } .dscr-stat { background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); padding: 8px 12px; }",
            ".dscr-stat-value { font-size: 18px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); } .dscr-stat-label { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }",
            ".dscr-field { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; font-size: 13px; } .dscr-field-label { color: var(--dsw-alias-label-secondary, inherit); } .dscr-field-value { color: var(--dsw-alias-label-primary, inherit); text-align: right; overflow-wrap: anywhere; }",
            ".dscr-textarea { width: 100%; min-height: 220px; box-sizing: border-box; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; padding: 8px; color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); resize: vertical; }",
            ".dscr-help { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); margin: 8px 0 0; } .dscr-btns { display: flex; flex-wrap: wrap; gap: 8px; }",
            ".dscr-btn { padding: 6px 12px; font-size: 13px; cursor: pointer; color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); } .dscr-btn:disabled { opacity: 0.5; cursor: default; }",
            ".dscr-busy { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); margin-top: 8px; } .dscr-banner { margin-top: 4px; padding: 8px 12px; font-size: 13px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary, inherit); overflow-wrap: anywhere; } .dscr-banner-error strong { color: var(--dsw-alias-state-error-primary, inherit); }",
            ".dscr-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 16px; } .dscr-form-row { display: flex; flex-direction: column; gap: 4px; } .dscr-form-row label { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); } .dscr-input { padding: 6px 8px; font-size: 13px; color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); } .dscr-check { display: flex; align-items: center; gap: 6px; }",
            ".dscr-strip { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); padding: 10px 14px; color: var(--dsw-alias-label-primary, inherit); } .dscr-strip-stats { display: flex; flex-wrap: wrap; gap: 18px; } .dscr-strip-stat { display: flex; flex-direction: column; gap: 2px; } .dscr-strip-value { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); } .dscr-strip-label { font-size: 11px; color: var(--dsw-alias-label-secondary, inherit); }",
            ".dscr-strip-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; } .dscr-pill { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); } .dscr-pill-dot { width: 6px; height: 6px; border-radius: 999px; background: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit)); } .dscr-pill-on .dscr-pill-dot { background: var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary)); }",
            ".dscr-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--dsw-alias-border-l1); } .dscr-tab { position: relative; padding: 8px 14px; font-size: 13px; color: var(--dsw-alias-label-secondary, inherit); background: transparent; border: 0; border-bottom: 2px solid transparent; cursor: pointer; } .dscr-tab:hover { color: var(--dsw-alias-label-primary, inherit); } .dscr-tab-active { color: var(--dsw-alias-label-primary, inherit); border-bottom-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary)); font-weight: 600; } .dscr-tab:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; } .dscr-tab-dot { display: inline-block; width: 6px; height: 6px; margin-left: 6px; border-radius: 999px; vertical-align: middle; background: var(--dsw-alias-state-business-primary, var(--dsw-alias-label-primary)); }",
            ".dscr-panel { display: flex; flex-direction: column; gap: 12px; } .dscr-panel[hidden] { display: none; } .dscr-panel:focus-visible { outline: 1px solid var(--dsw-alias-border-l2); outline-offset: 2px; }",
            ".dscr-btn-small { padding: 4px 10px; font-size: 12px; } .dscr-unsaved { align-self: center; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }",
            ".dscr-details .dscr-summary { cursor: pointer; margin: 0; } .dscr-details[open] .dscr-summary { margin-bottom: 12px; }",
            ".dscr-log-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin: 12px 0 4px; } .dscr-log-control { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); } .dscr-log-control .dscr-input { width: 110px; } .dscr-log-count { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); margin: 4px 0 8px; } .dscr-log-pending { color: var(--dsw-alias-label-secondary, inherit); } .dscr-log-error { font-size: 12px; color: var(--dsw-alias-state-error-primary, inherit); margin: 4px 0 8px; } .dscr-log-list { max-height: 360px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); padding: 8px; } .dscr-log-list:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; } .dscr-log-row { display: flex; gap: 8px; padding: 2px 0; color: var(--dsw-alias-label-primary, inherit); } .dscr-log-time { flex-shrink: 0; white-space: nowrap; color: var(--dsw-alias-label-secondary, inherit); } .dscr-log-level { flex-shrink: 0; font-weight: 600; color: var(--dsw-alias-label-secondary, inherit); } .dscr-log-level-error { color: var(--dsw-alias-state-error-primary, inherit); } .dscr-log-level-warn { color: var(--dsw-alias-state-warn-primary, inherit); } .dscr-log-message { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }",
            ".dscr-browse-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 12px 0 8px; } .dscr-browse-scope { max-width: 220px; }",
            ".dscr-browse-search { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 12px 0 0; } .dscr-browse-search-input { flex: 1 1 200px; min-width: 0; } .dscr-browse-search-status { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); margin: 0 0 8px; overflow-wrap: anywhere; } .dscr-browse-search-fallback { color: var(--dsw-alias-state-warn-primary, inherit); }",
            ".dscr-browse-search-kind { flex-shrink: 0; font-size: 11px; padding: 1px 6px; border-radius: 999px; color: var(--dsw-alias-label-secondary, inherit); background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2, inherit)); border: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; } .dscr-browse-search-pill { flex-shrink: 0; font-size: 11px; padding: 1px 6px; border-radius: 999px; color: var(--dsw-alias-label-secondary, inherit); background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2, inherit)); border: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; } .dscr-browse-search-marker { font-weight: 600; }",
            ".dscr-browse-row-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }",
            ".dscr-browse-mode { display: inline-flex; border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); overflow: hidden; } .dscr-browse-mode-btn { padding: 6px 12px; font-size: 13px; cursor: pointer; color: var(--dsw-alias-label-secondary, inherit); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)); border: 0; border-right: 1px solid var(--dsw-alias-border-l1); } .dscr-browse-mode-btn:last-child { border-right: 0; } .dscr-browse-mode-btn[aria-pressed='true'] { color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-layer-1, inherit); font-weight: 600; } .dscr-browse-mode-btn:disabled { opacity: 0.5; cursor: default; } .dscr-browse-mode-btn:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }",
            ".dscr-browse-toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); cursor: pointer; } .dscr-browse-toggle input:disabled { cursor: default; }",
            ".dscr-browse-checkline { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); margin: 0 0 8px; overflow-wrap: anywhere; } .dscr-browse-check-title { font-weight: 600; color: var(--dsw-alias-label-primary, inherit); } .dscr-browse-check-mismatches { color: var(--dsw-alias-state-warn-primary, inherit); }",
            ".dscr-browse-split { display: flex; align-items: stretch; gap: 12px; } .dscr-browse-list { flex: 0 0 clamp(280px, 38%, 420px); min-width: 0; display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); padding: 12px; } .dscr-browse-detail { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); padding: 12px; }",
            ".dscr-browse-panel-title { font-size: 13px; font-weight: 600; margin: 0 0 8px; color: var(--dsw-alias-label-primary, inherit); }",
            ".dscr-browse-list-scroll { overflow-y: auto; max-height: 68vh; display: flex; flex-direction: column; gap: 6px; } .dscr-browse-list-scroll:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }",
            ".dscr-browse-row { display: flex; flex-direction: column; gap: 4px; width: 100%; text-align: left; padding: 8px 10px; font-size: 13px; cursor: pointer; color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); } .dscr-browse-row:hover { border-color: var(--dsw-alias-border-l2); } .dscr-browse-row-selected { border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-border-l2)); box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary, var(--dsw-alias-border-l2)); } .dscr-browse-row:disabled { opacity: 0.6; cursor: default; } .dscr-browse-row:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }",
            ".dscr-browse-row-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; } .dscr-browse-row-main { flex: 1 1 auto; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; } .dscr-browse-row-sub { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); min-width: 0; } .dscr-browse-row-desc { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; } .dscr-browse-row-meta { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; } .dscr-browse-row-date { flex-shrink: 0; }",
            ".dscr-browse-badge { flex-shrink: 0; font-size: 11px; padding: 1px 6px; border-radius: 999px; color: var(--dsw-alias-label-secondary, inherit); background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2, inherit)); border: 1px solid var(--dsw-alias-border-l1); }",
            ".dscr-browse-pill { display: inline-block; flex-shrink: 0; font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid transparent; } .dscr-browse-pill-consistent { color: var(--dsw-alias-state-success-primary, inherit); border-color: var(--dsw-alias-state-success-primary, inherit); } .dscr-browse-pill-missing, .dscr-browse-pill-corrupt { color: var(--dsw-alias-state-error-primary, inherit); border-color: var(--dsw-alias-state-error-primary, inherit); } .dscr-browse-pill-stale-text, .dscr-browse-pill-model-mismatch { color: var(--dsw-alias-state-warn-primary, inherit); border-color: var(--dsw-alias-state-warn-primary, inherit); } .dscr-browse-pill-pending, .dscr-browse-pill-unknown, .dscr-browse-pill-orphan { color: var(--dsw-alias-label-secondary, inherit); border-color: var(--dsw-alias-border-l2, var(--dsw-alias-border-l1)); }",
            ".dscr-browse-meta { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; font-size: 13px; margin-bottom: 12px; } .dscr-browse-meta-row { display: contents; } .dscr-browse-meta-label { color: var(--dsw-alias-label-secondary, inherit); overflow-wrap: anywhere; } .dscr-browse-meta-value { color: var(--dsw-alias-label-primary, inherit); overflow-wrap: anywhere; text-align: right; }",
            ".dscr-browse-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }",
            ".dscr-browse-section { font-size: 12px; font-weight: 600; margin: 10px 0 4px; color: var(--dsw-alias-label-secondary, inherit); }",
            ".dscr-browse-content { margin: 0; padding: 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dsw-alias-label-primary, inherit); background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1)); border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); max-height: 40vh; overflow-y: auto; }",
            ".dscr-browse-note { font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); margin: 4px 0 0; }",
            ".dscr-browse-empty { font-size: 13px; color: var(--dsw-alias-label-secondary, inherit); margin: 8px 0; } .dscr-browse-error { font-size: 13px; color: var(--dsw-alias-state-error-primary, inherit); margin: 8px 0; }",
            ".dscr-browse-more { align-self: center; margin: 8px 0 2px; }",
            "@media (max-width: 720px) { .dscr-browse-split { flex-direction: column; } .dscr-browse-list { flex: 1 1 auto; width: 100%; max-height: 45vh; } }",
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
