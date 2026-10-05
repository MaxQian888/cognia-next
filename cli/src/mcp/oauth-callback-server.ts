/**
 * Local loopback HTTP server that captures the OAuth authorization-code
 * redirect for the `/mcp auth` flow. The provider registers
 * `http://127.0.0.1:<port>/callback` as the redirect URI; after the user
 * approves in the browser the authorization server redirects here with
 * `?code=...&state=...`, which the flow exchanges for tokens via `finishAuth`.
 *
 * The request-parsing logic is a pure function so it's unit-tested without a
 * socket; `startCallbackServer` is the thin live wrapper.
 */
import nodeHttp from "node:http"

import { CALLBACK_ICONS } from "./callback-icons"

export interface CallbackResult {
  code?: string
  state?: string
  error?: string
  errorDescription?: string
}

/** Parse the query of a redirect request (`/callback?...`) into a result. */
export function parseCallback(requestUrl: string): CallbackResult {
  let query: URLSearchParams
  try {
    query = new URL(requestUrl, "http://127.0.0.1").searchParams
  } catch {
    return {}
  }
  return {
    code: query.get("code") ?? undefined,
    state: query.get("state") ?? undefined,
    error: query.get("error") ?? undefined,
    errorDescription: query.get("error_description") ?? undefined,
  }
}

export type CallbackPageLocale = "en" | "zh"

/** The page's language, from the browser's `Accept-Language`. */
export function callbackPageLocale(acceptLanguage: string | undefined): CallbackPageLocale {
  return /^\s*zh\b/i.test(acceptLanguage ?? "") ? "zh" : "en"
}

const PAGE_COPY = {
  en: {
    okTitle: "Authorization complete",
    okBody: "You can close this tab and return to the terminal.",
    terminal: "cognia-agent is continuing",
    failTitle: "Authorization did not complete",
    failNext: "Return to the terminal and run the command again.",
    unknown: "unknown error",
  },
  zh: {
    okTitle: "授权完成",
    okBody: "可以关闭此标签页，回到终端继续。",
    terminal: "cognia-agent 正在继续",
    failTitle: "授权未完成",
    failNext: "请回到终端，重新运行刚才的命令。",
    unknown: "未知错误",
  },
} as const

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

// Cognia's palette, mark and chibi spot icons, as the identity Worker's hosted
// pages draw them (services/identity-server/src/pages/document.ts; sources of
// truth web/app/globals.css and web/components/brand-mark.tsx), so the browser
// tab a sign-in ends on looks like the pages it started on.
const PAGE_STYLE = `:root{color-scheme:light dark;--paper:#f3f1ec;--surface:#faf9f6;--ink:#0c1115;--muted:#5f666e;--hairline:#d7d8d5;--hairline-strong:#b9bcb8;--action:#35cedd;--glow:rgb(53 206 221 / 16%);--grid:rgb(12 17 21 / 7%);--band-top:#dff4f6;--band-bottom:#f4faf9}
@media (prefers-color-scheme:dark){:root{--paper:#0c1115;--surface:#151b20;--ink:#f3f1ec;--muted:#8e959b;--hairline:#2a333a;--hairline-strong:#3c464e;--action:#4fdcea;--glow:rgb(79 220 234 / 14%);--grid:rgb(243 241 236 / 6%);--band-top:#12292e;--band-bottom:#151b20}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--ink);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased;background:radial-gradient(64rem 34rem at 50% -10rem,var(--glow),transparent 70%),radial-gradient(circle,var(--grid) 1px,transparent 1.3px) 0 0/24px 24px,var(--paper)}
.page{min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 20px}.top,.stage{width:min(1040px,100%)}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;font-size:16px;letter-spacing:-.01em}.brand svg{width:26px;height:26px}
.stage{flex:1;display:grid;place-items:center;padding:36px 0}
.card{position:relative;width:min(440px,100%);background:var(--surface);border:1px solid var(--hairline);border-radius:22px;overflow:hidden;text-align:center;box-shadow:0 1px 2px rgb(12 17 21 / 4%),0 28px 64px -32px rgb(12 17 21 / 30%)}
.card::after{content:"";position:absolute;inset:0 0 auto;height:3px;background:linear-gradient(90deg,transparent,var(--action),transparent);opacity:.75}
.hero{position:relative;height:184px;display:flex;justify-content:center;align-items:center;border-bottom:1px solid var(--hairline);background:radial-gradient(circle at 50% 118%,var(--glow),transparent 62%),linear-gradient(180deg,var(--band-top),var(--band-bottom))}
.hero img{position:relative;width:148px;height:148px;display:block;filter:drop-shadow(0 10px 18px rgb(12 17 21 / 14%))}
.content{padding:28px 36px 32px}h1{font-size:23px;line-height:1.3;margin:0 0 8px;letter-spacing:-.015em}p{margin:0 0 18px;color:var(--muted)}p:last-child{margin:0}
.code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;padding:8px 10px;border:1px dashed var(--hairline-strong);border-radius:8px;overflow-wrap:anywhere}
.terminal{display:inline-flex;align-items:center;gap:8px;margin-top:4px;padding:6px 12px;border:1px solid var(--hairline);border-radius:999px;font:12px ui-monospace,SFMono-Regular,monospace;color:var(--muted)}.terminal::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--action)}
@media (max-width:480px){.content{padding:24px 22px 26px}.hero{height:164px}.hero img{width:132px;height:132px}h1{font-size:21px}}`

const BRAND_MARK = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><rect x="3.25" y="3.25" width="17.5" height="17.5" rx="2.5" stroke="currentColor" stroke-width="1.4" opacity=".55"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity=".9"><path d="M12 1.5v2.4"/><path d="M12 20.1v2.4"/><path d="M1.5 12h2.4"/><path d="M20.1 12h2.4"/></g><path d="M6.9 9.1h3.4a1.6 1.6 0 0 1 1.6 1.6v3.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="11.9" cy="15.9" r="1.75" fill="var(--action)"/></svg>`

/**
 * The page the browser tab shows once the redirect lands. The error and its
 * description come from the query string, which anyone can craft, so every
 * interpolated value is escaped.
 */
export function resultPage(result: CallbackResult, locale: CallbackPageLocale = "en"): string {
  const copy = PAGE_COPY[locale]
  const ok = Boolean(result.code && !result.error)
  const title = ok ? copy.okTitle : copy.failTitle
  const reason = `${result.error ?? copy.unknown}${
    result.errorDescription ? `: ${result.errorDescription}` : ""
  }`
  const body = ok
    ? `<h1>${title}</h1><p>${copy.okBody}</p><span class="terminal">${copy.terminal}</span>`
    : `<h1>${title}</h1><p class="code">${escapeHtml(reason)}</p><p>${copy.failNext}</p>`
  return (
    `<!doctype html><html lang="${locale === "zh" ? "zh-CN" : "en"}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">` +
    `<title>${title} · Cognia</title><style>${PAGE_STYLE}</style></head>` +
    `<body><div class="page"><header class="top"><div class="brand">${BRAND_MARK}<span>Cognia</span></div></header>` +
    `<div class="stage"><main class="card" data-outcome="${ok ? "ok" : "failed"}"><div class="hero"><img src="${CALLBACK_ICONS[ok ? "done" : "failed"]}" alt="" width="148" height="148"></div>` +
    `<div class="content">${body}</div></main></div></div></body></html>`
  )
}

export interface CallbackServer {
  /** Loopback redirect URI the provider must register. */
  redirectUrl: string
  /** Resolves with the captured code (rejects on error / timeout). */
  waitForCode(timeoutMs: number): Promise<CallbackResult>
  close(): void
}

export interface StartCallbackDeps {
  createServer?: typeof nodeHttp.createServer
  /** Preferred loopback port; 0 (default) picks a free ephemeral port. */
  port?: number
  path?: string
}

/** Start the loopback callback server and resolve once it's listening. */
export function startCallbackServer(deps: StartCallbackDeps = {}): Promise<CallbackServer> {
  const createServer = deps.createServer ?? nodeHttp.createServer
  const path = deps.path ?? "/callback"
  return new Promise((resolve, reject) => {
    let settle: ((r: CallbackResult) => void) | undefined
    let fail: ((e: Error) => void) | undefined
    let captured: CallbackResult | undefined
    let capturedError: Error | undefined

    const server = createServer((req, res) => {
      const result = parseCallback(req.url ?? "")
      if (!req.url || !req.url.startsWith(path)) {
        res.statusCode = 404
        res.end("Not found")
        return
      }
      res.statusCode = result.error ? 400 : 200
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.setHeader("cache-control", "no-store")
      res.setHeader("referrer-policy", "no-referrer")
      res.end(resultPage(result, callbackPageLocale(req.headers["accept-language"])))
      if (result.error) {
        const err = new Error(
          `Authorization denied: ${result.error}${
            result.errorDescription ? ` (${result.errorDescription})` : ""
          }`
        )
        if (fail) fail(err)
        else capturedError = err
      } else if (settle) settle(result)
      else captured = result
    })

    server.on("error", reject)
    server.listen(deps.port ?? 0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : deps.port
      resolve({
        redirectUrl: `http://127.0.0.1:${port}${path}`,
        waitForCode: (timeoutMs: number) =>
          new Promise<CallbackResult>((res2, rej2) => {
            if (capturedError) return rej2(capturedError)
            if (captured) return res2(captured)
            settle = res2
            fail = rej2
            const t = setTimeout(
              () => rej2(new Error(`Timed out waiting for OAuth callback after ${timeoutMs}ms`)),
              timeoutMs
            )
            if (typeof t === "object" && "unref" in t) t.unref()
          }),
        close: () => server.close(),
      })
    })
  })
}
