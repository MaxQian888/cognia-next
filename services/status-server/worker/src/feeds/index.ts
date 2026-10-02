/**
 * Feeds module (owner E): `GET /feed.atom` and `GET /feed.rss`.
 * Anonymous, credentials-free CORS, cacheable for 60 s. Exports exactly the
 * `FeedsModule` surface of `src/seams.ts`.
 */

import { applyPublicCors, errorResponse, publicPreflight } from "../platform/http"
import type { FeedsModule } from "../seams"
import { relativeApiPath } from "../incidents/ids"
import { loadFeedEntries, renderAtom, renderRss } from "./feed"

const FEED_CACHE_CONTROL = "public, max-age=60"

const CONTENT_TYPES = {
  "/feed.atom": "application/atom+xml; charset=utf-8",
  "/feed.rss": "application/rss+xml; charset=utf-8",
} as const

export const handleFeedRoutes: FeedsModule["handleFeedRoutes"] = async (request, env, ctx) => {
  const path = relativeApiPath(ctx.url)
  if (path !== "/feed.atom" && path !== "/feed.rss") return null
  if (request.method === "OPTIONS") return publicPreflight()
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse("method_not_allowed", ctx, {
      headers: { allow: "GET, HEAD, OPTIONS" },
      publicRead: true,
    })
  }
  const entries = await loadFeedEntries(env)
  const body =
    path === "/feed.atom" ? renderAtom(env, entries, ctx.nowMs) : renderRss(env, entries, ctx.nowMs)
  const headers = new Headers({
    "content-type": CONTENT_TYPES[path],
    "cache-control": FEED_CACHE_CONTROL,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  })
  applyPublicCors(headers)
  return new Response(request.method === "HEAD" ? null : body, { status: 200, headers })
}
