/**
 * Answer this Worker's own JWKS URL in-process.
 *
 * The OAuth provider verifies an RP-initiated logout's `id_token_hint` by
 * downloading the issuer's JWKS over HTTP, from `${BASE_URL}/api/auth/jwks`,
 * that is from this very Worker. A Worker fetching its own custom domain is a
 * pointless round trip through Cloudflare's edge (and, in tests, a host that
 * does not exist). This wraps the global `fetch` once so a GET to exactly that
 * URL is served from Better Auth's key set directly; every other request goes
 * to the network untouched.
 */

type JwksSource = () => Promise<unknown>

const routes = new Map<string, JwksSource>()
let installed = false

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  return input.url
}

function requestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
}

/** Serve `jwksUrl` from `source` for the rest of this isolate's life. */
export function serveOwnJwks(jwksUrl: string, source: JwksSource): void {
  routes.set(new URL(jwksUrl).href, source)
  if (installed) return
  installed = true
  const network = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = requestMethod(input, init)
    const source =
      method === "GET" || method === "HEAD"
        ? routes.get(new URL(requestUrl(input)).href)
        : undefined
    if (!source) return network(input, init)
    return Response.json(await source(), { headers: { "cache-control": "no-store" } })
  }) as typeof fetch
}

/** Test seam: forget the registered routes (the wrapper stays and passes everything through). */
export function resetOwnJwks(): void {
  routes.clear()
}
