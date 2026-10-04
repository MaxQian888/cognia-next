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
    failTitle: "Authorization did not complete",
    failNext: "Return to the terminal and run the command again.",
    unknown: "unknown error",
  },
  zh: {
    okTitle: "授权完成",
    okBody: "可以关闭此标签页，回到终端继续。",
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

// Cognia's palette and mark, as the identity Worker's hosted pages draw them
// (services/identity-server/src/pages/document.ts; sources of truth
// web/app/globals.css and web/components/brand-mark.tsx), so the browser tab
// a sign-in ends on looks like the pages it started on.
const PAGE_STYLE = `:root{color-scheme:light dark;--paper:#f3f1ec;--surface:#faf9f6;--ink:#0c1115;--muted:#5f666e;--hairline:#d7d8d5;--action:#35cedd;--success:#2a6f49;--destructive:#b3261e}
@media (prefers-color-scheme:dark){:root{--paper:#0c1115;--surface:#151b20;--ink:#f3f1ec;--muted:#8e959b;--hairline:#2a333a;--action:#4fdcea;--success:#57c08a;--destructive:#f2837c}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
main{width:min(400px,calc(100vw - 32px));background:var(--surface);border:1px solid var(--hairline);border-radius:14px;padding:28px 28px 24px;box-shadow:0 1px 2px rgb(12 17 21 / 4%),0 12px 32px -16px rgb(12 17 21 / 18%)}
.brand{display:flex;align-items:center;gap:8px;margin:0 0 24px;font-weight:600;letter-spacing:-.01em}.brand svg{width:22px;height:22px}
.state{width:40px;height:40px;border-radius:10px;display:grid;place-items:center;margin:0 0 14px;border:1px solid var(--hairline)}.state svg{width:20px;height:20px}
.state.success{color:var(--success)}.state.error{color:var(--destructive)}
h1{font-size:19px;line-height:1.3;margin:0 0 8px;letter-spacing:-.01em}p{margin:0 0 16px;color:var(--muted)}p:last-child{margin:0}
.code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;padding:8px 10px;border:1px solid var(--hairline);border-radius:8px;overflow-wrap:anywhere}`

const BRAND_MARK = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><rect x="3.25" y="3.25" width="17.5" height="17.5" rx="2.5" stroke="currentColor" stroke-width="1.4" opacity=".55"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity=".9"><path d="M12 1.5v2.4"/><path d="M12 20.1v2.4"/><path d="M1.5 12h2.4"/><path d="M20.1 12h2.4"/></g><path d="M6.9 9.1h3.4a1.6 1.6 0 0 1 1.6 1.6v3.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="11.9" cy="15.9" r="1.75" fill="var(--action)"/></svg>`
const OK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`
const FAIL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 7v6"/><path d="M12 17h.01"/></svg>`

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
    ? `<div class="state success">${OK_ICON}</div><h1>${title}</h1><p>${copy.okBody}</p>`
    : `<div class="state error">${FAIL_ICON}</div><h1>${title}</h1>` +
      `<p class="code">${escapeHtml(reason)}</p><p>${copy.failNext}</p>`
  return (
    `<!doctype html><html lang="${locale === "zh" ? "zh-CN" : "en"}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">` +
    `<title>${title} · Cognia</title><style>${PAGE_STYLE}</style></head>` +
    `<body><main><div class="brand">${BRAND_MARK}<span>Cognia</span></div>${body}</main></body></html>`
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
