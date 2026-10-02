/**
 * Static `/status` assets (the status-only slice of the app's static export).
 *
 * The asset binding only holds the status page and the chunks it references
 * (scripts/build/build-status-site.mjs), so nothing else of the application
 * export is reachable here. HTML gets the runtime `<meta>` that tells the
 * page it is the primary deployment and where its same-origin API lives, and
 * a CSP that limits it to this origin; the app's PWA manifest link is removed.
 */

import { STATUS_RUNTIME_META_NAME } from "../../../../lib/status/config"
import type { Env } from "./env"

export const STATUS_CSP = [
  "default-src 'self'",
  // Next's static export streams its RSC payload through inline scripts.
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ")

const RUNTIME_META = JSON.stringify({ mode: "primary", apiBase: "/api/status/v1" })

/**
 * The exported page registers the app's PWA service worker (`@serwist/next`
 * does so on every route). The status host must not precache the whole app,
 * and a 404 would surface as an unhandled registration error on every visit,
 * so `/sw.js` here is deliberately inert: it activates and claims clients so
 * the registration resolves, and it has no fetch handler, so it never
 * intercepts, caches or alters a request.
 */
export const INERT_SERVICE_WORKER = `// Cognia status: intentionally inert service worker (no fetch handler, no caches).
self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))
`

function withSecurityHeaders(response: Response, html: boolean): Response {
  const headers = new Headers(response.headers)
  headers.set("x-content-type-options", "nosniff")
  headers.set("referrer-policy", "strict-origin-when-cross-origin")
  headers.set("x-frame-options", "DENY")
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()")
  if (html) {
    headers.set("content-security-policy", STATUS_CSP)
    // Assets are versioned by hash; the HTML must always be revalidated so
    // it never references chunks a newer deploy removed.
    headers.set("cache-control", "no-cache")
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

class RuntimeMetaInjector {
  private done = false
  element(element: Element): void {
    if (this.done) return
    this.done = true
    element.prepend(`<meta name="${STATUS_RUNTIME_META_NAME}" content='${RUNTIME_META}'>`, {
      html: true,
    })
  }
}

/** Drops an element: a stale runtime meta, or the app's PWA manifest link. */
class RemoveElement {
  element(element: Element): void {
    element.remove()
  }
}

export async function serveStatusAsset(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } })
  }
  if (url.pathname === "/") {
    return Response.redirect(`${url.origin}/status/${url.search}`, 302)
  }
  if (url.pathname === "/sw.js") {
    return withSecurityHeaders(
      new Response(request.method === "HEAD" ? null : INERT_SERVICE_WORKER, {
        headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" },
      }),
      false
    )
  }
  if (url.pathname === "/status" || url.pathname === "/status.html") {
    return Response.redirect(`${url.origin}/status/${url.search}`, 301)
  }
  const response = await env.ASSETS.fetch(request)
  if (response.status === 404) {
    return withSecurityHeaders(
      new Response("Not Found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
      false
    )
  }
  const isHtml = (response.headers.get("content-type") ?? "").includes("text/html")
  if (!isHtml) return withSecurityHeaders(response, false)
  const rewritten = new HTMLRewriter()
    .on(`meta[name="${STATUS_RUNTIME_META_NAME}"]`, new RemoveElement())
    // The exported head links the Cognia app's manifest (start_url `/`,
    // shortcuts into app routes). The status host is not that installable
    // app and does not ship the manifest, so the link is removed.
    .on('link[rel="manifest"]', new RemoveElement())
    .on("head", new RuntimeMetaInjector())
    .transform(response)
  return withSecurityHeaders(rewritten, true)
}
