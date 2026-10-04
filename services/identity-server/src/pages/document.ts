/**
 * The HTML shell every hosted page renders into, and its response headers.
 *
 * Each response carries a fresh nonce: the only script and style that run are
 * the inline ones stamped with it (`script-src 'nonce-…'`). Data reaches the
 * script through a JSON block, never by string-splicing values into code, and
 * every interpolated text is HTML-escaped.
 */

import type { Locale } from "./strings"

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/** JSON for a `<script type="application/json">` block: `<` can never close the tag. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}

export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f7f7f8;--card:#fff;--fg:#18181b;--muted:#71717a;--border:#e4e4e7;--accent:#18181b;--accent-fg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--card:#18181b;--fg:#fafafa;--muted:#a1a1aa;--border:#27272a;--accent:#fafafa;--accent-fg:#18181b}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
main{width:min(400px,calc(100vw - 32px));background:var(--card);border:1px solid var(--border);border-radius:16px;padding:32px}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}ul{margin:0 0 20px;padding-left:20px}
button{display:block;width:100%;margin:0 0 10px;padding:10px 14px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--fg);font:inherit;cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}button:disabled{opacity:.6;cursor:default}
.status{min-height:1.5em;color:var(--muted);font-size:13px}.code{font-family:ui-monospace,monospace;font-size:12px}
`

export interface DocumentInput {
  locale: Locale
  title: string
  nonce: string
  body: string
  /** Serialised into `<script id="page-data" type="application/json">`. */
  data?: unknown
  script?: string
}

export function renderDocument(input: DocumentInput): string {
  const lang = input.locale === "zh" ? "zh-CN" : "en"
  const data =
    input.data === undefined
      ? ""
      : `<script id="page-data" type="application/json">${jsonForScript(input.data)}</script>`
  const script = input.script ? `<script nonce="${input.nonce}">${input.script}</script>` : ""
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(input.title)}</title>
<style nonce="${input.nonce}">${STYLE}</style></head>
<body><main>${input.body}</main>${data}${script}</body></html>`
}

export function htmlResponse(html: string, nonce: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "connect-src 'self'",
        "img-src 'self' data:",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ].join("; "),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
    },
  })
}
