// Content-Security-Policy builder for sandboxed plugin webviews (B3).
//
// A plugin webview is an `<iframe sandbox="allow-scripts">` (no
// `allow-same-origin` → opaque origin, postMessage-only). The CSP injected
// into the served HTML clamps the frame's own network egress (`connect-src`)
// to the SAME allowlist `ctx.network` uses — so an in-frame fetch/XHR/WS can
// never reach a host the plugin couldn't reach itself.
//
// Egress semantics mirror `lib/plugin/security/network-allowlist.ts`
// (`evaluateEgress`): a plugin with no `allowedDomains` declaration is
// unrestricted (`connect-src *`); `["*"]` is likewise unrestricted; an
// explicit list is clamped to those origins over https/wss.

export interface WebviewCspInput {
  /** `manifest.networkAccess.allowedDomains` for the owning plugin. */
  allowedDomains?: string[]
}

function connectSrc(allowedDomains: string[] | undefined): string {
  if (!allowedDomains || allowedDomains.length === 0) return "*"
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
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<script>${acquireCogniaWebviewApiSource()}</script>
</head>
<body>${body}</body>
</html>`
}

/**
 * Source injected so the iframe script can call `acquireCogniaWebviewApi()` to
 * postMessage to the host and persist state across remounts. Opaque-origin
 * safe: it only talks to `window.parent` via postMessage.
 */
export function acquireCogniaWebviewApiSource(): string {
  return `
    (function () {
      var claimed = false;
      var lastState = undefined;
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
        };
      };
    }());
  `
}
