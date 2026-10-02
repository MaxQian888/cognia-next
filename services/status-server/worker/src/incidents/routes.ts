/**
 * Public incident reads: `GET /incidents` (cursor pages, newest first) and
 * `GET /incidents/:id` (detail with every update, oldest first). Anonymous,
 * credentials-free CORS, cacheable for 30 s.
 */

import { STATUS_SCHEMA_VERSION } from "../../../../../lib/status/contract"
import { errorResponse, json, publicPreflight } from "../platform/http"
import type { RouteHandler } from "../seams"
import { relativeApiPath } from "./ids"
import { listIncidentPage, loadIncidentDetail, parsePageQuery } from "./store"

export const INCIDENT_CACHE_CONTROL = "public, max-age=30"
const INCIDENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export const handleIncidentRoutes: RouteHandler = async (request, env, ctx) => {
  const path = relativeApiPath(ctx.url)
  if (path === null) return null
  const isList = path === "/incidents"
  const detailMatch = /^\/incidents\/([^/]+)$/.exec(path)
  if (!isList && !detailMatch) return null

  if (request.method === "OPTIONS") return publicPreflight()
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse("method_not_allowed", ctx, {
      headers: { allow: "GET, HEAD, OPTIONS" },
      publicRead: true,
    })
  }

  if (isList) {
    const query = parsePageQuery(ctx.url)
    if (!query) return errorResponse("bad_request", ctx, { publicRead: true })
    const { page } = await listIncidentPage(env.DB, query)
    return json(page, { publicRead: true, cacheControl: INCIDENT_CACHE_CONTROL })
  }

  // IDs never need percent-encoding; anything else is simply not found.
  const id = detailMatch?.[1] ?? ""
  if (!INCIDENT_ID_PATTERN.test(id)) return errorResponse("not_found", ctx, { publicRead: true })
  const incident = await loadIncidentDetail(env.DB, id)
  if (!incident) return errorResponse("not_found", ctx, { publicRead: true })
  return json(
    { schemaVersion: STATUS_SCHEMA_VERSION, incident },
    { publicRead: true, cacheControl: INCIDENT_CACHE_CONTROL }
  )
}
