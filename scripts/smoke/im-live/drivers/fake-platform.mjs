// Test-only: a local HTTP server the driver unit tests point their driver at.
//
// Not used by any live run. The drivers talk to real platforms; these tests
// prove the mapping between a platform's response shape and the harness's
// normalized shape, plus the error branches that are impossible to provoke on
// demand against a real service (a 403 for a missing scope, an `ok:false`
// envelope, a truncated page).

import { createServer } from "node:http"

/**
 * Start a server whose `routes` map `"<METHOD> <pathname>"` to a handler
 * receiving `{ query, body, headers }` and returning `{ status?, json?, text? }`.
 *
 * Unmatched requests answer 404 and are recorded, so a test can assert a driver
 * did NOT call something as easily as that it did.
 */
export async function withFakePlatform(routes, fn) {
  const calls = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      const url = new URL(req.url, "http://fake.local")
      const raw = Buffer.concat(chunks).toString("utf8")
      let body
      try {
        body = raw ? JSON.parse(raw) : undefined
      } catch {
        body = raw
      }
      const key = `${req.method} ${url.pathname}`
      calls.push({
        key,
        method: req.method,
        pathname: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body,
        headers: req.headers,
      })

      const handler = routes[key] ?? matchPattern(routes, req.method, url.pathname)
      if (!handler) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: `no fake route for ${key}` }))
        return
      }
      const out =
        handler({
          query: Object.fromEntries(url.searchParams),
          body,
          headers: req.headers,
          pathname: url.pathname,
        }) ?? {}
      if (out.text !== undefined) {
        res.writeHead(out.status ?? 200, { "content-type": out.contentType ?? "text/plain" })
        res.end(out.text)
        return
      }
      if (out.json === undefined) {
        res.writeHead(out.status ?? 204)
        res.end()
        return
      }
      res.writeHead(out.status ?? 200, { "content-type": "application/json" })
      res.end(JSON.stringify(out.json))
    })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn({ baseUrl, calls, callsTo: (key) => calls.filter((c) => c.key === key) })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** Routes may use `:param` segments, e.g. `"DELETE /channels/:id/messages/:messageId"`. */
function matchPattern(routes, method, pathname) {
  const segments = pathname.split("/")
  for (const [key, handler] of Object.entries(routes)) {
    const [routeMethod, routePath] = key.split(" ")
    if (routeMethod !== method) continue
    const routeSegments = routePath.split("/")
    if (routeSegments.length !== segments.length) continue
    const params = {}
    let matched = true
    for (let i = 0; i < routeSegments.length; i++) {
      if (routeSegments[i].startsWith(":")) {
        params[routeSegments[i].slice(1)] = decodeURIComponent(segments[i])
        continue
      }
      if (routeSegments[i] !== segments[i]) {
        matched = false
        break
      }
    }
    if (matched) return (input) => handler({ ...input, params })
  }
  return null
}
