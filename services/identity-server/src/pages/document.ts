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

// Cognia's own palette and mark (web/app/globals.css, web/components/brand-mark.tsx):
// warm paper and ink neutrals, hairlines, and the cyan `action` accent used
// only as a dot or a line, never as a text colour.
const STYLE = `
:root{color-scheme:light dark;--paper:#f3f1ec;--surface:#faf9f6;--ink:#0c1115;--muted:#5f666e;--hairline:#d7d8d5;--hairline-strong:#b9bcb8;--action:#35cedd;--success:#2a6f49;--destructive:#b3261e}
@media (prefers-color-scheme:dark){:root{--paper:#0c1115;--surface:#151b20;--ink:#f3f1ec;--muted:#8e959b;--hairline:#2a333a;--hairline-strong:#3c464e;--action:#4fdcea;--success:#57c08a;--destructive:#f2837c}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(400px,calc(100vw - 32px));background:var(--surface);border:1px solid var(--hairline);border-radius:14px;padding:28px 28px 24px;box-shadow:0 1px 2px rgb(12 17 21 / 4%),0 12px 32px -16px rgb(12 17 21 / 18%)}
.brand{display:flex;align-items:center;gap:8px;margin:0 0 24px;font-weight:600;letter-spacing:-.01em}.brand svg{width:22px;height:22px}
.state{width:40px;height:40px;border-radius:10px;display:grid;place-items:center;margin:0 0 14px;border:1px solid var(--hairline)}.state svg{width:20px;height:20px}
.state.success{color:var(--success)}.state.error{color:var(--destructive)}
h1{font-size:19px;line-height:1.3;margin:0 0 8px;letter-spacing:-.01em}p{margin:0 0 16px;color:var(--muted)}ul{margin:0 0 20px;padding-left:20px;color:var(--muted)}
button{display:block;width:100%;margin:0 0 10px;padding:10px 14px;border-radius:9px;border:1px solid var(--hairline-strong);background:var(--surface);color:var(--ink);font:inherit;font-weight:500;cursor:pointer;transition:border-color .15s,background .15s}
button:hover{border-color:var(--ink)}button:focus-visible{outline:2px solid var(--action);outline-offset:2px}
button.primary,a.button.primary{background:var(--ink);color:var(--paper);border-color:var(--ink)}
a.button{display:block;text-align:center;text-decoration:none;margin:0 0 10px;padding:10px 14px;border-radius:9px;border:1px solid var(--hairline-strong);color:var(--ink);font-weight:500}a.button:focus-visible{outline:2px solid var(--action);outline-offset:2px}button:disabled{opacity:.6;cursor:default}
.status{min-height:1.5em;color:var(--muted);font-size:13px}.code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;padding:8px 10px;border:1px solid var(--hairline);border-radius:8px;overflow-wrap:anywhere}
footer{margin-top:20px;padding-top:14px;border-top:1px solid var(--hairline);font-size:12px;color:var(--muted)}
`

/** The Cognia mark: aperture, registration ticks, the context path, and its cyan node. */
const BRAND_MARK = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><rect x="3.25" y="3.25" width="17.5" height="17.5" rx="2.5" stroke="currentColor" stroke-width="1.4" opacity=".55"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity=".9"><path d="M12 1.5v2.4"/><path d="M12 20.1v2.4"/><path d="M1.5 12h2.4"/><path d="M20.1 12h2.4"/></g><path d="M6.9 9.1h3.4a1.6 1.6 0 0 1 1.6 1.6v3.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="11.9" cy="15.9" r="1.75" fill="var(--action)"/></svg>`

const STATE_ICON = {
  success: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`,
  error: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 7v6"/><path d="M12 17h.01"/></svg>`,
} as const

export interface DocumentInput {
  locale: Locale
  title: string
  nonce: string
  body: string
  /** Serialised into `<script id="page-data" type="application/json">`. */
  data?: unknown
  script?: string
  /** A state tile above the heading, for pages that report an outcome. */
  state?: keyof typeof STATE_ICON
}

export function renderDocument(input: DocumentInput): string {
  const lang = input.locale === "zh" ? "zh-CN" : "en"
  const data =
    input.data === undefined
      ? ""
      : `<script id="page-data" type="application/json">${jsonForScript(input.data)}</script>`
  const script = input.script ? `<script nonce="${input.nonce}">${input.script}</script>` : ""
  const state = input.state
    ? `<div class="state ${input.state}">${STATE_ICON[input.state]}</div>`
    : ""
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${escapeHtml(input.title)}</title>
<style nonce="${input.nonce}">${STYLE}</style></head>
<body><main><div class="brand">${BRAND_MARK}<span>Cognia</span></div>${state}${input.body}</main>${data}${script}</body></html>`
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
