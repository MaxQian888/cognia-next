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

/** Minimal HTML shown in the browser tab once the redirect lands. */
export function resultPage(result: CallbackResult): string {
  const ok = result.code && !result.error
  const title = ok ? "Authorization complete" : "Authorization failed"
  const detail = ok
    ? "You can close this tab and return to the terminal."
    : `${result.error ?? "unknown error"}${result.errorDescription ? `: ${result.errorDescription}` : ""}`
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:14px system-ui;padding:2rem"><h2>${title}</h2><p>${detail}</p></body>`
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
      res.end(resultPage(result))
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
