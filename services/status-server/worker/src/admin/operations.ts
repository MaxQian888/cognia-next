/**
 * Idempotent, audited execution of operator writes.
 *
 * Every write carries a client `operationId`. A replay with the same body
 * returns the stored response; the same ID with a different body is a 409
 * `conflict`. A planned write commits in ONE batch with its operation record
 * and audit row, both conditional on the plan's guard (the CAS actually
 * changed its row), so:
 * - a lost compare-and-swap records nothing and is reported (usually 409
 *   `revision_conflict` with the safe current revision);
 * - two concurrent requests with the same `operationId` cannot both commit:
 *   the second batch fails on the operation primary key, rolls back, and is
 *   answered from the first one's record.
 * Rejected requests (validation, conflicts) are not recorded, so the same
 * ID can be retried after fixing the cause.
 */

import type { ParseResult } from "../../../../../lib/status/validate"
import { sha256Hex } from "../../../../../lib/status/signing"
import { committed } from "../incidents/store"
import { errorResponse, json, logEvent, readJsonBody, type RequestContext } from "../platform/http"
import { auditStatement, findOperation, recordOperationStatement } from "../platform/store"
import type { AdminMutationResult } from "../seams"
import type { Env } from "../env"
import type { MutationPlan, OperatorContext, WriteGuard } from "./mutation"

function replay(stored: { status: number; response: unknown }): Response {
  return json(stored.response, {
    status: stored.status,
    headers: { "x-idempotent-replay": "true" },
  })
}

async function guardedOperationRecord(
  db: D1Database,
  input: {
    operationId: string
    actor: string
    kind: string
    requestBytes: Uint8Array
    status: number
    response: unknown
    atMs: number
  },
  guard: WriteGuard
): Promise<D1PreparedStatement> {
  return db
    .prepare(
      `INSERT INTO admin_operations (operation_id, actor, kind, request_digest, status, response_json, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard.sql}`
    )
    .bind(
      input.operationId,
      input.actor,
      input.kind,
      await sha256Hex(input.requestBytes),
      input.status,
      JSON.stringify(input.response),
      input.atMs,
      ...guard.params
    )
}

type ParsedBody<T> = { ok: true; value: T; bytes: Uint8Array } | { ok: false; response: Response }

async function parseBody<T extends { operationId: string }>(
  request: Request,
  ctx: RequestContext,
  parse: (value: unknown) => ParseResult<T>
): Promise<ParsedBody<T>> {
  const body = await readJsonBody(request)
  if (!body.ok) return { ok: false, response: errorResponse(body.code, ctx) }
  const parsed = parse(body.value)
  if (!parsed.ok) return { ok: false, response: errorResponse("bad_request", ctx) }
  return { ok: true, value: parsed.value, bytes: body.bytes }
}

async function priorOperation(
  db: D1Database,
  operationId: string,
  bytes: Uint8Array,
  ctx: RequestContext
): Promise<Response | null> {
  const prior = await findOperation(db, operationId, bytes)
  if (!prior) return null
  return prior.sameRequest ? replay(prior) : errorResponse("conflict", ctx)
}

/** Parse, de-duplicate, plan, commit atomically with record + audit. */
export async function executePlannedWrite<T extends { operationId: string }>(
  request: Request,
  env: Env,
  ctx: RequestContext,
  input: {
    kind: string
    operator: OperatorContext
    parse: (value: unknown) => ParseResult<T>
    plan: (value: T) => Promise<MutationPlan>
  }
): Promise<Response> {
  const db = env.DB
  const body = await parseBody(request, ctx, input.parse)
  if (!body.ok) return body.response
  const operationId = body.value.operationId
  const prior = await priorOperation(db, operationId, body.bytes, ctx)
  if (prior) return prior

  const plan = await input.plan(body.value)
  if (plan.kind === "error") {
    return errorResponse(
      plan.code,
      ctx,
      plan.currentRevision === undefined ? {} : { currentRevision: plan.currentRevision }
    )
  }
  const statements = [
    ...plan.statements,
    await guardedOperationRecord(
      db,
      {
        operationId,
        actor: input.operator.actor,
        kind: input.kind,
        requestBytes: body.bytes,
        status: plan.result.status,
        response: plan.result.body,
        atMs: input.operator.nowMs,
      },
      plan.guard
    ),
    // Immediately after the guarded operation record: written only if it was.
    auditStatement(
      db,
      {
        ...plan.audit,
        atMs: input.operator.nowMs,
        actor: input.operator.actor,
        detail: { ...plan.audit.detail, operationId },
      },
      { onlyIfPreviousChanged: true }
    ),
    ...(plan.trailingStatements ?? []),
  ]
  let results: D1Result[]
  try {
    results = await db.batch(statements)
  } catch (error) {
    // A concurrent request with the same operation ID committed first.
    const raced = await priorOperation(db, operationId, body.bytes, ctx)
    if (raced) return raced
    throw error
  }
  if (!committed(results)) {
    const lost = await plan.onLostRace()
    return errorResponse(
      lost.code,
      ctx,
      lost.currentRevision === undefined ? {} : { currentRevision: lost.currentRevision }
    )
  }
  logEvent("admin.write", {
    requestId: ctx.requestId,
    kind: input.kind,
    operationId,
    status: plan.result.status,
  })
  return json(plan.result.body, { status: plan.result.status })
}

/**
 * Registry writes are applied (and audited) atomically by the registry
 * module itself; this wrapper adds operation-ID de-duplication. Only
 * successful results are recorded.
 */
export async function executeRegistryWrite<T extends { operationId: string }>(
  request: Request,
  env: Env,
  ctx: RequestContext,
  input: {
    kind: string
    operator: OperatorContext
    parse: (value: unknown) => ParseResult<T>
    apply: (value: T) => Promise<AdminMutationResult>
  }
): Promise<Response> {
  const db = env.DB
  const body = await parseBody(request, ctx, input.parse)
  if (!body.ok) return body.response
  const operationId = body.value.operationId
  const prior = await priorOperation(db, operationId, body.bytes, ctx)
  if (prior) return prior
  const result = await input.apply(body.value)
  if (result.status >= 200 && result.status < 300) {
    try {
      await (
        await recordOperationStatement(db, {
          operationId,
          actor: input.operator.actor,
          kind: input.kind,
          requestBytes: body.bytes,
          status: result.status,
          response: result.body,
          atMs: input.operator.nowMs,
        })
      ).run()
    } catch (error) {
      // Only a concurrent duplicate can collide here; its record stands.
      logEvent("admin.record_failed", {
        requestId: ctx.requestId,
        kind: input.kind,
        error: error instanceof Error ? error.name : "unknown",
      })
    }
    logEvent("admin.write", {
      requestId: ctx.requestId,
      kind: input.kind,
      operationId,
      status: result.status,
    })
    return json(result.body, { status: result.status })
  }
  const errorBody =
    result.body && typeof result.body === "object" && !Array.isArray(result.body)
      ? { ...(result.body as Record<string, unknown>), requestId: ctx.requestId }
      : {
          code:
            result.status === 404
              ? "not_found"
              : result.status === 409
                ? "conflict"
                : "bad_request",
          requestId: ctx.requestId,
        }
  return json(errorBody, { status: result.status })
}
