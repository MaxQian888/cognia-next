import nodeHttp from "node:http"
import type { CallbackResult, CallbackServer } from "./types.ts"

/** Parse the OAuth redirect query into a result object. (Pure — tested.) */
export function parseCallback(requestUrl: string): CallbackResult {
  let query
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

/** Start a loopback callback server; resolves once listening. */
export function startCallbackServer(): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let settle: ((result: CallbackResult) => void) | undefined
    let fail: ((error: Error) => void) | undefined
    let captured: CallbackResult | undefined
    let capturedError: Error | undefined
    const path = "/callback"
    const server = nodeHttp.createServer((req, res) => {
      if (!req.url || !req.url.startsWith(path)) {
        res.statusCode = 404
        res.end("Not found")
        return
      }
      const result = parseCallback(req.url)
      res.statusCode = result.error ? 400 : 200
      res.setHeader("content-type", "text/html; charset=utf-8")
      res.end(
        `<!doctype html><meta charset="utf-8"><body style="font:14px system-ui;padding:2rem"><h2>${
          result.error ? "Authorization failed" : "Authorization complete"
        }</h2><p>You can close this tab.</p></body>`
      )
      if (result.error) {
        const err = new Error(`Authorization denied: ${result.error}`)
        if (fail) fail(err)
        else capturedError = err
      } else if (settle) settle(result)
      else captured = result
    })
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      resolve({
        redirectUrl: `http://127.0.0.1:${port}${path}`,
        waitForCode: (timeoutMs: number) =>
          new Promise((res2, rej2) => {
            if (capturedError) return rej2(capturedError)
            if (captured) return res2(captured)
            settle = res2
            fail = rej2
            const t = setTimeout(() => rej2(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)
            if (typeof t === "object" && "unref" in t) t.unref()
          }),
        close: () => server.close(),
      })
    })
  })
}
