/**
 * `/api/status/v1/admin/*`: the operator API used by the status admin CLI.
 *
 * Access identity first (see `./access.ts`): no route, not even a 404, is
 * answered before the caller is an allowlisted operator. Then method/path
 * routing, boundary validation with the contract parsers, idempotent and
 * audited execution (`./operations.ts`). No CORS: the CLI is not a browser.
 *
 * Routes:
 *   GET  /admin/incidents?cursor=&limit=        every incident incl. resolved
 *   POST /admin/incidents                       create (manual, pinned)
 *   GET  /admin/incidents/:id                   detail with ownership flags
 *   POST /admin/incidents/:id/updates           update / pin / correction
 *   POST /admin/incidents/:id/resolve           resolve with audited reason
 *   GET  /admin/maintenance?cursor=&limit=      every window
 *   POST /admin/maintenance                     schedule
 *   POST /admin/maintenance/:id/{extend,reschedule,complete,cancel}
 *   GET  /admin/probes                          registry view
 *   POST /admin/probes                          enroll
 *   POST /admin/probes/disable                  disable / enable
 *   POST /admin/probes/set-reference            move the reference observer
 *   GET  /admin/delivery?state=&limit=          outbox view (no addresses)
 *   POST /admin/delivery/retry                  deliberate, audited retry
 */

import { STATUS_SCHEMA_VERSION } from "../../../../../lib/status/contract"
import {
  parseDeliveryRetry,
  parseIncidentCreate,
  parseIncidentResolve,
  parseIncidentUpdate,
  parseMaintenanceChange,
  parseMaintenanceSchedule,
  parseProbeDisable,
  parseProbeEnroll,
  parseProbeSetReference,
} from "../../../../../lib/status/validate"
import type { Env } from "../env"
import { relativeApiPath } from "../incidents/ids"
import {
  listAdminIncidents,
  loadAdminIncident,
  planIncidentCreate,
  planIncidentResolve,
  planIncidentUpdate,
} from "../incidents/admin"
import { encodeCursor, parsePageQuery } from "../incidents/store"
import {
  planMaintenanceChange,
  planMaintenanceSchedule,
  type MaintenanceAction,
} from "../maintenance/admin"
import { listMaintenanceRows, viewsFor } from "../maintenance/store"
import { listDeliveries, parseDeliveryQuery, planDeliveryRetry } from "../notifications/admin"
import { errorResponse, json, logEvent, type RequestContext } from "../platform/http"
import {
  enrollProbe,
  listProbesForAdmin,
  setProbeDisabled,
  setReferenceProbe,
} from "../registry/admin"
import type { RouteHandler } from "../seams"
import { verifyAccess } from "./access"
import type { OperatorContext } from "./mutation"
import { executePlannedWrite, executeRegistryWrite } from "./operations"

const ID = "([A-Za-z0-9][A-Za-z0-9._:-]{0,127})"

type Handler = (
  request: Request,
  env: Env,
  ctx: RequestContext,
  operator: OperatorContext,
  params: string[]
) => Promise<Response>

interface Route {
  pattern: RegExp
  methods: Partial<Record<"GET" | "POST", Handler>>
}

function methodNotAllowed(ctx: RequestContext, allowed: string[]): Response {
  return errorResponse("method_not_allowed", ctx, { headers: { allow: allowed.join(", ") } })
}

const MAINTENANCE_ACTIONS: readonly MaintenanceAction[] = [
  "extend",
  "reschedule",
  "complete",
  "cancel",
]

const ROUTES: Route[] = [
  {
    pattern: /^\/admin\/incidents$/,
    methods: {
      GET: async (_request, env, ctx) => {
        const query = parsePageQuery(ctx.url)
        if (!query) return errorResponse("bad_request", ctx)
        return json(await listAdminIncidents(env.DB, query))
      },
      POST: (request, env, ctx, operator) =>
        executePlannedWrite(request, env, ctx, {
          kind: "incident.create",
          operator,
          parse: parseIncidentCreate,
          plan: (value) => planIncidentCreate(env.DB, value, operator),
        }),
    },
  },
  {
    pattern: new RegExp(`^/admin/incidents/${ID}$`),
    methods: {
      GET: async (_request, env, ctx, _operator, [id]) => {
        const incident = await loadAdminIncident(env.DB, id ?? "")
        return incident
          ? json({ schemaVersion: STATUS_SCHEMA_VERSION, incident })
          : errorResponse("not_found", ctx)
      },
    },
  },
  {
    pattern: new RegExp(`^/admin/incidents/${ID}/updates$`),
    methods: {
      POST: (request, env, ctx, operator, [id]) =>
        executePlannedWrite(request, env, ctx, {
          kind: "incident.update",
          operator,
          parse: parseIncidentUpdate,
          plan: (value) => planIncidentUpdate(env.DB, id ?? "", value, operator),
        }),
    },
  },
  {
    pattern: new RegExp(`^/admin/incidents/${ID}/resolve$`),
    methods: {
      POST: (request, env, ctx, operator, [id]) =>
        executePlannedWrite(request, env, ctx, {
          kind: "incident.resolve",
          operator,
          parse: parseIncidentResolve,
          plan: (value) => planIncidentResolve(env.DB, id ?? "", value, operator),
        }),
    },
  },
  {
    pattern: /^\/admin\/maintenance$/,
    methods: {
      GET: async (_request, env, ctx) => {
        const query = parsePageQuery(ctx.url)
        if (!query) return errorResponse("bad_request", ctx)
        const { rows, hasMore } = await listMaintenanceRows(env.DB, query)
        const last = rows[rows.length - 1]
        return json({
          schemaVersion: STATUS_SCHEMA_VERSION,
          maintenance: await viewsFor(env.DB, rows),
          nextCursor:
            hasMore && last ? encodeCursor({ startedAt: last.starts_at, id: last.id }) : null,
        })
      },
      POST: (request, env, ctx, operator) =>
        executePlannedWrite(request, env, ctx, {
          kind: "maintenance.schedule",
          operator,
          parse: parseMaintenanceSchedule,
          plan: (value) => planMaintenanceSchedule(env.DB, value, operator),
        }),
    },
  },
  {
    pattern: new RegExp(`^/admin/maintenance/${ID}/(extend|reschedule|complete|cancel)$`),
    methods: {
      POST: (request, env, ctx, operator, [id, action]) => {
        const kind = action as MaintenanceAction
        if (!MAINTENANCE_ACTIONS.includes(kind))
          return Promise.resolve(errorResponse("not_found", ctx))
        return executePlannedWrite(request, env, ctx, {
          kind: `maintenance.${kind}`,
          operator,
          parse: parseMaintenanceChange,
          plan: (value) => planMaintenanceChange(env.DB, id ?? "", kind, value, operator),
        })
      },
    },
  },
  {
    pattern: /^\/admin\/probes$/,
    methods: {
      GET: async (_request, env, _ctx, operator) =>
        json({
          schemaVersion: STATUS_SCHEMA_VERSION,
          probes: await listProbesForAdmin(env, operator.nowMs),
        }),
      POST: (request, env, ctx, operator) =>
        executeRegistryWrite(request, env, ctx, {
          kind: "probe.enroll",
          operator,
          parse: parseProbeEnroll,
          apply: (value) => enrollProbe(env, value, operator.actor, operator.nowMs),
        }),
    },
  },
  {
    pattern: /^\/admin\/probes\/disable$/,
    methods: {
      POST: (request, env, ctx, operator) =>
        executeRegistryWrite(request, env, ctx, {
          kind: "probe.disable",
          operator,
          parse: parseProbeDisable,
          apply: (value) => setProbeDisabled(env, value, operator.actor, operator.nowMs),
        }),
    },
  },
  {
    pattern: /^\/admin\/probes\/set-reference$/,
    methods: {
      POST: (request, env, ctx, operator) =>
        executeRegistryWrite(request, env, ctx, {
          kind: "probe.set_reference",
          operator,
          parse: parseProbeSetReference,
          apply: (value) => setReferenceProbe(env, value, operator.actor, operator.nowMs),
        }),
    },
  },
  {
    pattern: /^\/admin\/delivery$/,
    methods: {
      GET: async (_request, env, ctx) => {
        const query = parseDeliveryQuery(ctx.url)
        if (!query) return errorResponse("bad_request", ctx)
        return json(await listDeliveries(env.DB, query))
      },
    },
  },
  {
    pattern: /^\/admin\/delivery\/retry$/,
    methods: {
      POST: (request, env, ctx, operator) =>
        executePlannedWrite(request, env, ctx, {
          kind: "delivery.retry",
          operator,
          parse: parseDeliveryRetry,
          plan: (value) => planDeliveryRetry(env.DB, value, operator),
        }),
    },
  },
]

export const handleAdminRoutes: RouteHandler = async (request, env, ctx) => {
  const path = relativeApiPath(ctx.url)
  if (path === null || (path !== "/admin" && !path.startsWith("/admin/"))) return null

  const verdict = await verifyAccess(request, env, ctx.nowMs)
  if (!verdict.ok) {
    logEvent("admin.denied", { requestId: ctx.requestId, reason: verdict.reason })
    return errorResponse(verdict.code, ctx)
  }
  const operator: OperatorContext = { actor: verdict.email, nowMs: ctx.nowMs }

  for (const route of ROUTES) {
    const match = route.pattern.exec(path)
    if (!match) continue
    const method = request.method === "HEAD" ? "GET" : request.method
    const handler = route.methods[method as "GET" | "POST"]
    if (!handler) return methodNotAllowed(ctx, Object.keys(route.methods))
    return handler(request, env, ctx, operator, match.slice(1))
  }
  return errorResponse("not_found", ctx)
}
