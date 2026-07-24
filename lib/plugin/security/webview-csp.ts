// Content-Security-Policy builder for sandboxed plugin webviews (B3).
//
// A plugin webview is an `<iframe sandbox="allow-scripts">` (no
// `allow-same-origin` → opaque origin, postMessage-only). The CSP injected
// into the served HTML clamps the frame's own network egress (`connect-src`)
// to the SAME allowlist `ctx.network` uses — so an in-frame fetch/XHR/WS can
// never reach a host the plugin couldn't reach itself.
//
// Egress semantics mirror the Rust host gate
// (`src-tauri/src/plugin_api/mod.rs::network_host_allowed`): a plugin with no
// `allowedDomains` declaration is DENIED by default (`connect-src 'none'`,
// fail-closed) — declaring `network:fetch` alone no longer implies
// unrestricted egress; `["*"]` is an explicit opt-in to unrestricted egress;
// an explicit list is clamped to those origins over https/wss.

export interface WebviewCspInput {
  /** `manifest.networkAccess.allowedDomains` for the owning plugin. */
  allowedDomains?: string[]
  /**
   * Also inject `acquireCogniaContextPanelApi()` — set by the webview bridge
   * for webviews referenced by a `contextPanels[].webview` and for every
   * webview of a plugin declaring the `context-panel` capability (an RPC
   * `register({ webview })` can make any of those a panel body later, and the
   * srcDoc is wrapped exactly once, at enable). Plugins without the
   * capability keep the minimal surface.
   */
  contextPanelApi?: boolean
}

function connectSrc(allowedDomains: string[] | undefined): string {
  // No declaration at all → deny by default (fail-closed); an empty array is
  // treated the same as "no declaration" for this purpose.
  if (!allowedDomains || allowedDomains.length === 0) return "'none'"
  if (allowedDomains.includes("*")) return "*"
  // Expand each declared host into https + wss origins. A leading-dot or
  // bare host is treated as the host itself; wildcards pass through.
  const origins = new Set<string>()
  for (const raw of allowedDomains) {
    const host = raw.trim()
    if (!host) continue
    origins.add(`https://${host}`)
    origins.add(`wss://${host}`)
  }
  return origins.size > 0 ? [...origins].join(" ") : "'none'"
}

/**
 * Build the CSP string for a webview's
 * `<meta http-equiv="Content-Security-Policy">`. Scripts/styles are inline
 * (the plugin owns the document), images allow data:/blob:, and egress is
 * clamped to the plugin's declared domains.
 */
export function buildWebviewCsp(input: WebviewCspInput): string {
  const connect = connectSrc(input.allowedDomains)
  const imgConnect = connect === "*" ? "*" : connect
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval'",
    "style-src 'unsafe-inline'",
    `img-src data: blob: ${imgConnect}`,
    "font-src data:",
    `connect-src ${connect}`,
  ].join("; ")
}

/**
 * Wrap a plugin's raw webview HTML body in a full document with the CSP meta
 * tag and the cognia webview API polyfill spliced in. The result is what the
 * iframe `srcDoc` is set to.
 */
export function wrapWebviewHtml(body: string, input: WebviewCspInput): string {
  const csp = buildWebviewCsp(input)
  const contextPanelScript = input.contextPanelApi
    ? `\n<script>${acquireCogniaContextPanelApiSource()}</script>`
    : ""
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<script>${acquireCogniaWebviewApiSource()}</script>${contextPanelScript}
</head>
<body>${body}</body>
</html>`
}

/**
 * Source injected so the iframe script can call `acquireCogniaWebviewApi()` to
 * postMessage to the host and persist state across remounts. Opaque-origin
 * safe: it only talks to `window.parent` via postMessage.
 */
/**
 * Source injected for webview-backed CONTEXT PANELS only: the in-frame half of
 * the context-panel RPC. `acquireCogniaContextPanelApi()` mirrors the host
 * API — requests go out as envelopes over the generic webview transport, the
 * host answers with response envelopes, and `onDidChange*` subscriptions are
 * local listener lists fed by pushed events. Unknown response ids are ignored
 * because the registry fans host pushes out to every live frame of the same
 * webview. Acquiring sends a `ready` marker so the host replays a state
 * snapshot the frame may have missed while booting.
 */
export function acquireCogniaContextPanelApiSource(): string {
  return `
    (function () {
      var claimed = false;
      var CHANNEL = "cognia.contextPanel";
      window.acquireCogniaContextPanelApi = function () {
        if (claimed) throw new Error("acquireCogniaContextPanelApi() can only be called once.");
        claimed = true;
        var nextId = 1;
        var pending = {};
        var listeners = { activeContext: [], workbenchState: [], visibility: [] };
        window.addEventListener("message", function (event) {
          var payload = event.data;
          if (!payload || payload.__cogniaWebview !== "host") return;
          var data = payload.data;
          if (!data || data.channel !== CHANNEL) return;
          if (data.kind === "response") {
            var entry = pending[data.id];
            if (!entry) return;
            delete pending[data.id];
            clearTimeout(entry.timer);
            if (data.ok) { entry.resolve(data.result); }
            else { entry.reject(new Error(data.error || "context-panel request failed")); }
          } else if (data.kind === "event" && listeners[data.event]) {
            listeners[data.event].forEach(function (fn) {
              try { fn(data.payload); } catch (err) {}
            });
          }
        });
        function call(method, params) {
          return new Promise(function (resolve, reject) {
            var id = nextId++;
            var timer = setTimeout(function () {
              delete pending[id];
              reject(new Error("context-panel request timed out: " + method));
            }, 5000);
            pending[id] = { resolve: resolve, reject: reject, timer: timer };
            window.parent.postMessage(
              { __cogniaWebview: "post", data: { channel: CHANNEL, kind: "request", id: id, method: method, params: params } },
              "*"
            );
          });
        }
        function on(event) {
          return function (fn) {
            listeners[event].push(fn);
            return function () {
              var index = listeners[event].indexOf(fn);
              if (index >= 0) listeners[event].splice(index, 1);
            };
          };
        }
        window.parent.postMessage(
          { __cogniaWebview: "post", data: { channel: CHANNEL, kind: "ready" } },
          "*"
        );
        return {
          reveal: function (panelId, mode) { return call("reveal", [panelId, mode]); },
          setBadge: function (panelId, count) { return call("setBadge", [panelId, count]); },
          getActiveContext: function () { return call("getActiveContext", []); },
          getWorkbenchState: function () { return call("getWorkbenchState", []); },
          setMode: function (mode) { return call("setMode", [mode]); },
          setPinned: function (pinned) { return call("setPinned", [pinned]); },
          register: function (registration) { return call("register", [registration]); },
          dispose: function (registrationId) { return call("dispose", [registrationId]); },
          onDidChangeActiveContext: on("activeContext"),
          onDidChangeWorkbenchState: on("workbenchState"),
          onDidChangeVisibility: on("visibility"),
        };
      };
    }());
  `
}

export function acquireCogniaWebviewApiSource(): string {
  // State round-trip: `setState` is stored HOST-side (the frame dies with
  // every panel unmount), and the host replays it as a `restore-state`
  // message into the next frame on load. The listener attaches at script
  // eval — before any plugin code can call `acquireCogniaWebviewApi()` — so
  // `getState()` sees the seed; `onDidChangeState` covers a restore landing
  // after acquire.
  return `
    (function () {
      var claimed = false;
      var lastState = undefined;
      var stateListeners = [];
      window.addEventListener("message", function (event) {
        var payload = event.data;
        if (!payload || payload.__cogniaWebview !== "restore-state") return;
        lastState = payload.state;
        stateListeners.forEach(function (fn) {
          try { fn(payload.state); } catch (err) {}
        });
      });
      window.acquireCogniaWebviewApi = function () {
        if (claimed) throw new Error("acquireCogniaWebviewApi() can only be called once.");
        claimed = true;
        return {
          postMessage: function (data) {
            window.parent.postMessage({ __cogniaWebview: "post", data: data }, "*");
          },
          getState: function () { return lastState; },
          setState: function (state) {
            lastState = state;
            window.parent.postMessage({ __cogniaWebview: "set-state", state: state }, "*");
          },
          onDidChangeState: function (fn) {
            stateListeners.push(fn);
            return function () {
              var index = stateListeners.indexOf(fn);
              if (index >= 0) stateListeners.splice(index, 1);
            };
          },
        };
      };
    }());
  `
}
