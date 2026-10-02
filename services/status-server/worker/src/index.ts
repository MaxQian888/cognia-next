/**
 * Cognia public status Worker.
 *
 *   /api/status/v1/*   JSON API (anonymous reads, signed probe writes,
 *                      token-scoped subscription writes, Access-gated admin)
 *   /status/*, assets  the exported status page (status-only distribution)
 *   /                  302 → /status/
 *
 * API paths are routed before assets, and an unknown API path is a JSON 404,
 * never the page's HTML. The Cron trigger runs the reference probe,
 * aggregation, reconciliation and delivery every minute (src/cron.ts).
 *
 * The runtime accepts only handlers as this module's exports, so shared
 * constants live in `./modules`.
 *
 * Plan: docs/plans/2026-10-02-signaling-public-status-implementation.md
 */

import { serveStatusAsset } from "./assets"
import { runScheduled } from "./cron"
import type { Env } from "./env"
import { handleFeedRoutes } from "./feeds"
import * as incidents from "./incidents"
import { handleObservationPost, OBSERVATIONS_PATH } from "./ingest/route"
import { API_PREFIX, cronModules } from "./modules"
import { handleAdminRoutes } from "./admin"
import {
  createRequestContext,
  errorResponse,
  logEvent,
  publicPreflight,
  type RequestContext,
} from "./platform/http"
import { handleHealthz, handleSnapshot } from "./public/routes"
import type { RouteHandler } from "./seams"
import * as subscriptions from "./subscriptions"

/** Anonymous, credentials-free GET endpoints (CORS preflight allowed). */
const PUBLIC_READ_PREFIXES = ["/snapshot", "/healthz", "/incidents", "/feed."]

const MODULE_ROUTES: RouteHandler[] = [
  incidents.handleIncidentRoutes,
  handleFeedRoutes,
  subscriptions.handleSubscriptionRoutes,
  handleAdminRoutes,
]

async function routeApi(request: Request, env: Env, ctx: RequestContext): Promise<Response> {
  const sub = ctx.url.pathname.slice(API_PREFIX.length) || "/"
  const method = request.method
  if (method === "OPTIONS") {
    return PUBLIC_READ_PREFIXES.some((prefix) => sub.startsWith(prefix))
      ? publicPreflight()
      : errorResponse("method_not_allowed", ctx)
  }
  if (sub === "/snapshot") {
    return method === "GET" || method === "HEAD"
      ? handleSnapshot(request, env, ctx)
      : errorResponse("method_not_allowed", ctx)
  }
  if (sub === "/healthz") {
    return method === "GET" || method === "HEAD"
      ? handleHealthz(env, ctx)
      : errorResponse("method_not_allowed", ctx)
  }
  if (ctx.url.pathname === OBSERVATIONS_PATH) {
    return method === "POST"
      ? handleObservationPost(request, env, ctx)
      : errorResponse("method_not_allowed", ctx)
  }
  for (const handler of MODULE_ROUTES) {
    const response = await handler(request, env, ctx)
    if (response) return response
  }
  return errorResponse("not_found", ctx)
}

export default {
  async fetch(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
    const ctx = createRequestContext(request, executionCtx)
    const path = ctx.url.pathname
    if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) {
      try {
        return await routeApi(request, env, ctx)
      } catch (error) {
        logEvent("api.unhandled", {
          requestId: ctx.requestId,
          error: error instanceof Error ? error.name : "unknown",
        })
        return errorResponse("internal", ctx)
      }
    }
    if (path === "/api" || path.startsWith("/api/")) return errorResponse("not_found", ctx)
    return serveStatusAsset(request, env, ctx.url)
  },

  async scheduled(
    controller: ScheduledController,
    env: Env,
    executionCtx: ExecutionContext
  ): Promise<void> {
    executionCtx.waitUntil(runScheduled(env, controller.scheduledTime, cronModules))
  },
} satisfies ExportedHandler<Env>
