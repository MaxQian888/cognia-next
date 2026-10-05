/**
 * The HTML shell every hosted page renders into, and its response headers.
 *
 * Each response carries a fresh nonce: the only script and style that run are
 * the inline ones stamped with it (`script-src 'nonce-…'`). Data reaches the
 * script through a JSON block, never by string-splicing values into code, and
 * every interpolated text is HTML-escaped.
 */

import { PAGE_ICONS, type PageIcon } from "./page-icons"
import { t, type Locale } from "./strings"

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
// only as a dot, a line or a glow, never as a text colour. The hero band and
// the dot grid echo the mark's registration ticks. The one playful element is
// a chibi spot icon from the app's own set (./page-icons.ts).
const STYLE = `
:root{color-scheme:light dark;--paper:#f3f1ec;--surface:#faf9f6;--ink:#0c1115;--muted:#5f666e;--hairline:#d7d8d5;--hairline-strong:#b9bcb8;--action:#35cedd;--success:#2a6f49;--destructive:#b3261e;--glow:rgb(53 206 221 / 16%);--grid:rgb(12 17 21 / 7%);--band-top:#dff4f6;--band-bottom:#f4faf9;--disc:#d9f2f5}
@media (prefers-color-scheme:dark){:root{--paper:#0c1115;--surface:#151b20;--ink:#f3f1ec;--muted:#8e959b;--hairline:#2a333a;--hairline-strong:#3c464e;--action:#4fdcea;--success:#57c08a;--destructive:#f2837c;--glow:rgb(79 220 234 / 14%);--grid:rgb(243 241 236 / 6%);--band-top:#12292e;--band-bottom:#151b20;--disc:#173238}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;color:var(--ink);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased;background:radial-gradient(64rem 34rem at 50% -10rem,var(--glow),transparent 70%),radial-gradient(circle,var(--grid) 1px,transparent 1.3px) 0 0/24px 24px,var(--paper)}
.page{min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 20px}
.top,.stage,.foot{width:min(1040px,100%)}
.top{display:flex;align-items:center}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;font-size:16px;letter-spacing:-.01em;color:var(--ink);text-decoration:none}.brand svg{width:26px;height:26px}
.brand small{font-size:13px;font-weight:500;color:var(--muted);padding-left:10px;border-left:1px solid var(--hairline)}
.stage{flex:1;display:grid;place-items:center;padding:36px 0}
.card{position:relative;width:min(440px,100%);background:var(--surface);border:1px solid var(--hairline);border-radius:22px;overflow:hidden;text-align:center;box-shadow:0 1px 2px rgb(12 17 21 / 4%),0 28px 64px -32px rgb(12 17 21 / 30%)}
.card::after{content:"";position:absolute;inset:0 0 auto;height:3px;background:linear-gradient(90deg,transparent,var(--action),transparent);opacity:.75}
.hero{position:relative;height:184px;display:flex;justify-content:center;align-items:center;border-bottom:1px solid var(--hairline);background:radial-gradient(circle at 50% 118%,var(--glow),transparent 62%),linear-gradient(180deg,var(--band-top),var(--band-bottom))}
.hero::before{content:"";position:absolute;inset:0;background:radial-gradient(circle,var(--grid) 1px,transparent 1.3px) 0 0/16px 16px;-webkit-mask-image:linear-gradient(180deg,#000,transparent);mask-image:linear-gradient(180deg,#000,transparent)}
.hero img{position:relative;width:148px;height:148px;display:block;filter:drop-shadow(0 10px 18px rgb(12 17 21 / 14%))}
.content{padding:28px 36px 32px}
h1{font-size:23px;line-height:1.3;margin:0 0 8px;letter-spacing:-.015em}
p{margin:0 0 18px;color:var(--muted)}ul{margin:0 0 22px;padding:0;list-style:none;text-align:left}
li{display:flex;gap:10px;align-items:baseline;padding:9px 12px;border:1px solid var(--hairline);border-radius:10px;margin:0 0 8px;color:var(--ink);font-size:14px}li::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:var(--action);transform:translateY(-2px)}
.actions{display:grid;gap:10px;margin:6px 0 4px}
button,a.button{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:48px;padding:11px 16px;border-radius:12px;border:1px solid var(--hairline-strong);background:var(--surface);color:var(--ink);font:inherit;font-weight:550;text-decoration:none;cursor:pointer;transition:border-color .15s,box-shadow .15s,transform .15s}
button:hover:not(:disabled),a.button:hover{border-color:var(--ink);box-shadow:0 6px 18px -10px rgb(12 17 21 / 35%);transform:translateY(-1px)}
button:focus-visible,a.button:focus-visible{outline:2px solid var(--action);outline-offset:2px}
button.primary,a.button.primary{background:var(--ink);color:var(--paper);border-color:var(--ink)}
button .go{margin-left:auto;color:var(--muted)}button.primary .go{color:inherit}button.provider{justify-content:flex-start}
button:disabled{opacity:.55;cursor:default}
.status{min-height:1.6em;margin-top:10px;color:var(--muted);font-size:13px}.status:empty{min-height:0;margin:0}
.code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;padding:8px 10px;border:1px dashed var(--hairline-strong);border-radius:8px;overflow-wrap:anywhere}
.content footer{margin-top:22px;padding-top:16px;border-top:1px solid var(--hairline);font-size:13px;color:var(--muted)}
.foot{display:flex;justify-content:center;gap:8px;font-size:12px;color:var(--muted)}.foot a{color:inherit;text-decoration:none}.foot a:hover{color:var(--ink)}
.showcase{display:none}
@media (min-width:880px){
.stage.split{grid-template-columns:minmax(0,1fr) 440px;gap:72px}
.split .showcase{display:block}
.split .card .hero{display:none}
.split .card .content{padding:48px 44px 40px}.split h1{font-size:27px;margin-bottom:10px}.split .card p{margin-bottom:26px}
.showcase .disc{width:300px;height:300px;border-radius:50%;background:radial-gradient(circle at 50% 35%,var(--band-top),var(--disc));border:1px solid var(--hairline);box-shadow:0 30px 80px -40px rgb(53 206 221 / 60%);display:flex;align-items:center;justify-content:center;margin:0 0 32px}
.showcase .disc img{width:244px;height:244px;display:block;filter:drop-shadow(0 16px 28px rgb(12 17 21 / 16%))}
.showcase h2{font-size:38px;line-height:1.15;letter-spacing:-.025em;margin:0 0 14px;max-width:14em}
.showcase p{font-size:17px;max-width:26em}
}
@media (max-width:480px){.content{padding:24px 22px 26px}.hero{height:164px}.hero img{width:132px;height:132px}h1{font-size:21px}}
@media (prefers-reduced-motion:reduce){button,a.button{transition:none}button:hover:not(:disabled),a.button:hover{transform:none}}
`

/** The Cognia mark: aperture, registration ticks, the context path, and its cyan node. */
const BRAND_MARK = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><rect x="3.25" y="3.25" width="17.5" height="17.5" rx="2.5" stroke="currentColor" stroke-width="1.4" opacity=".55"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity=".9"><path d="M12 1.5v2.4"/><path d="M12 20.1v2.4"/><path d="M1.5 12h2.4"/><path d="M20.1 12h2.4"/></g><path d="M6.9 9.1h3.4a1.6 1.6 0 0 1 1.6 1.6v3.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="11.9" cy="15.9" r="1.75" fill="var(--action)"/></svg>`

/** The trailing arrow on a button that leaves the page. */
export const GO_ICON = `<svg class="go" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>`

export interface DocumentInput {
  locale: Locale
  title: string
  nonce: string
  body: string
  /** Serialised into `<script id="page-data" type="application/json">`. */
  data?: unknown
  script?: string
  /** The spot icon in the card's hero band; it says how things went. */
  icon: PageIcon
  /**
   * A wide-screen showcase beside the card (the sign-in page): the icon
   * large, a heading and a line. Narrow screens keep the card's hero instead.
   */
  showcase?: { heading: string; text: string }
}

export function renderDocument(input: DocumentInput): string {
  const lang = input.locale === "zh" ? "zh-CN" : "en"
  const data =
    input.data === undefined
      ? ""
      : `<script id="page-data" type="application/json">${jsonForScript(input.data)}</script>`
  const script = input.script ? `<script nonce="${input.nonce}">${input.script}</script>` : ""
  const art = (size: number) =>
    `<img src="${PAGE_ICONS[input.icon]}" alt="" width="${size}" height="${size}" decoding="async">`
  const showcase = input.showcase
    ? `<section class="showcase"><div class="disc">${art(244)}</div><h2>${escapeHtml(input.showcase.heading)}</h2><p>${escapeHtml(input.showcase.text)}</p></section>`
    : ""
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark"><title>${escapeHtml(input.title)}</title>
<style nonce="${input.nonce}">${STYLE}</style></head>
<body><div class="page"><header class="top"><a class="brand" href="https://cognia.cn">${BRAND_MARK}<span>Cognia</span><small>${escapeHtml(t(input.locale, "brand.account"))}</small></a></header>
<div class="stage${showcase ? " split" : ""}">${showcase}<main class="card" data-icon="${input.icon}"><div class="hero">${art(148)}</div><div class="content">${input.body}</div></main></div>
<footer class="foot"><span>&copy; Cognia</span><span aria-hidden="true">&middot;</span><a href="https://cognia.cn">cognia.cn</a></footer></div>${data}${script}</body></html>`
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
