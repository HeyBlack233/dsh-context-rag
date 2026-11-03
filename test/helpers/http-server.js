/**
 * Small in-process HTTP servers for tests. No real network is used: servers
 * listen on 127.0.0.1 with an ephemeral port.
 *
 * @module http-server
 */

import { createServer } from "node:http";

/**
 * Case-insensitive check whether a plain headers object already contains a
 * header name.
 *
 * @param {Record<string, string>} headers
 * @param {string} name
 * @returns {boolean}
 */
function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

/**
 * Start a raw HTTP server on 127.0.0.1 with an ephemeral port.
 *
 * Every request is recorded — `{ method, url, headers, body, bodyJson }` —
 * before the handler runs; `bodyJson` is the parsed JSON body when the body
 * parses, otherwise undefined.
 *
 * @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, record: object) => void} handler
 *   Called with the request, response, and the recorded request entry.
 * @returns {Promise<{url: string, close: () => Promise<void>, requests: Array<object>}>}
 */
export async function startHttpServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let bodyJson;
      try {
        bodyJson = body ? JSON.parse(body) : undefined;
      } catch {
        bodyJson = undefined;
      }
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
        bodyJson,
      };
      requests.push(record);
      handler(req, res, record);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  /**
   * Close the server and wait for it to fully shut down. Idle keep-alive
   * connections are destroyed so the close callback fires promptly.
   *
   * @returns {Promise<void>}
   */
  function close() {
    return new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
      server.closeAllConnections?.();
    });
  }

  return { url, close, requests };
}

/**
 * Start a JSON API server driven by a route table.
 *
 * `routes` maps a URL pathname to either:
 * - a function `(record) => ({ status?, headers?, body? })` returning the
 *   response spec, or
 * - an array of such specs to cycle through per pathname (one spec per
 *   request; once exhausted the last spec repeats).
 *
 * `status` defaults to 200. `body` may be an object (JSON-encoded) or a raw
 * string; a `content-type: application/json` header is added unless the spec
 * already provides one. Unmatched paths return 404 JSON.
 *
 * @param {Record<string, (record: object) => object | Array<object>>} routes
 * @returns {Promise<{url: string, close: () => Promise<void>, requests: Array<object>}>}
 */
export async function startJsonServer(routes) {
  const counters = new Map();
  return startHttpServer((req, res, record) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const route = routes[pathname];
    if (!route) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: `no route for ${pathname}` }));
      return;
    }

    let spec = typeof route === "function" ? route(record) : route;
    if (Array.isArray(spec)) {
      const index = counters.get(pathname) ?? 0;
      counters.set(pathname, index + 1);
      spec = spec[Math.min(index, spec.length - 1)];
    }

    const { status = 200, headers = {}, body = null } = spec ?? {};
    res.statusCode = status;
    for (const [name, value] of Object.entries(headers)) {
      res.setHeader(name, value);
    }
    if (body === null || body === undefined) {
      res.end();
    } else if (!hasHeader(headers, "content-type")) {
      res.setHeader("content-type", "application/json");
      if (typeof body === "string") {
        res.end(body);
      } else {
        res.end(JSON.stringify(body));
      }
    } else if (typeof body === "string") {
      res.end(body);
    } else {
      res.end(JSON.stringify(body));
    }
  });
}
