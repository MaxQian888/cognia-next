/**
 * `POST /api/status/v1/observations`: signed probe ingestion.
 *
 * The signature covers method, exact path, timestamp, run ID and the raw
 * body digest; the key ID resolves to exactly one registered probe, and the
 * batch may only speak for that probe. Errors carry bounded codes and never
 * echo the body.
 */

import type { ObservationAccepted } from "../../../../../lib/status/contract"
import { verifyProbeRequest } from "../../../../../lib/status/signing"
import { parseObservationBatch, isUnsupportedSchemaError } from "../../../../../lib/status/validate"
import type { Env } from "../env"
import {
  errorResponse,
  json,
  logEvent,
  readBoundedBody,
  type RequestContext,
} from "../platform/http"
import { loadRegistry, resolveProbeKey } from "../registry/registry"
import { recordObservation } from "./record"

export const OBSERVATIONS_PATH = "/api/status/v1/observations"

export async function handleObservationPost(
  request: Request,
  env: Env,
  ctx: RequestContext
): Promise<Response> {
  if (ctx.url.search !== "") return errorResponse("bad_request", ctx)
  const body = await readBoundedBody(request)
  if (!body.ok) return errorResponse(body.code, ctx)

  let resolvedProbeId: string | null = null
  const verdict = await verifyProbeRequest({
    headers: request.headers,
    method: request.method,
    path: ctx.url.pathname,
    body: body.bytes,
    nowMs: ctx.nowMs,
    resolveSecret: async (keyId) => {
      const key = await resolveProbeKey(env, keyId, ctx.nowMs)
      resolvedProbeId = key?.probeId ?? null
      return key?.secret ?? null
    },
  })
  if (!verdict.ok) {
    logEvent("ingest.signature_rejected", { reason: verdict.reason, requestId: ctx.requestId })
    return errorResponse("unauthorized", ctx)
  }
  const probeId = resolvedProbeId as string | null
  if (!probeId) return errorResponse("unauthorized", ctx)

  let raw: unknown
  try {
    raw = JSON.parse(body.text)
  } catch {
    return errorResponse("bad_request", ctx)
  }
  const parsed = parseObservationBatch(raw)
  if (!parsed.ok) {
    return errorResponse(
      isUnsupportedSchemaError(parsed.error) ? "unsupported_schema" : "bad_request",
      ctx
    )
  }
  // The signed run ID header and the body must name the same run.
  if (parsed.value.runId !== verdict.runId) return errorResponse("bad_request", ctx)

  const registry = await loadRegistry(env.DB)
  const outcome = await recordObservation({
    db: env.DB,
    registry,
    batch: parsed.value,
    authenticatedProbeId: probeId,
    nowMs: ctx.nowMs,
  })
  if (!outcome.ok) {
    logEvent("ingest.refused", { probeId, reason: outcome.reason, requestId: ctx.requestId })
    return errorResponse(outcome.code, ctx)
  }
  const accepted: ObservationAccepted = { status: outcome.status, runId: parsed.value.runId }
  return json(accepted, { status: outcome.status === "accepted" ? 202 : 200 })
}
