/**
 * `/api/account/deletion` (ADR-0215 §10, grill Q12).
 *
 *   GET     → the person's deletion state
 *   POST    → start the cooling-off period; body `{ "id_token": "<fresh ID token>" }`
 *   DELETE  → cancel a pending request
 *
 * Signing in keeps working during the cooling-off period, so the person can
 * come back and cancel. Cancelling is explicit, never implied by a sign-in.
 */

import { AccountTokenError, bearerToken, verifyAccessToken, verifyFreshIdToken } from "./tokens"
import { cancelDeletion, getDeletion, requestDeletion, type DeletionRecord } from "./store"
import type { JSONWebKeySet } from "jose"

export interface DeletionRouteDeps {
  db: D1Database
  issuer: string
  audience: string
  coolingOffDays: number
  jwks: () => Promise<JSONWebKeySet>
  now?: () => Date
}

export interface DeletionState {
  status: "none" | "pending" | "cancelled"
  requestedAt?: string
  purgeAfter?: string
}

function stateOf(record: DeletionRecord | null): DeletionState {
  if (!record || record.status === "purged") return { status: "none" }
  if (record.status === "cancelled") return { status: "cancelled" }
  return { status: "pending", requestedAt: record.requestedAt, purgeAfter: record.purgeAfter }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } })
}

function oauthError(status: number, error: string, description: string): Response {
  const response = json({ error, error_description: description }, status)
  if (status === 401) response.headers.set("www-authenticate", `Bearer error="${error}"`)
  return response
}

export async function handleDeletionRequest(
  request: Request,
  deps: DeletionRouteDeps
): Promise<Response> {
  const method = request.method.toUpperCase()
  if (method !== "GET" && method !== "POST" && method !== "DELETE") {
    return new Response(null, { status: 405, headers: { allow: "GET, POST, DELETE" } })
  }
  const token = bearerToken(request)
  if (!token) return oauthError(401, "invalid_token", "a bearer access token is required")
  const now = deps.now?.() ?? new Date()
  try {
    const jwks = await deps.jwks()
    const userId = await verifyAccessToken(token, {
      jwks,
      issuer: deps.issuer,
      audience: deps.audience,
    })
    if (method === "GET") return json(stateOf(await getDeletion(deps.db, userId)))
    if (method === "DELETE") {
      await cancelDeletion(deps.db, userId, now)
      return json(stateOf(await getDeletion(deps.db, userId)))
    }
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return oauthError(400, "invalid_request", "the body must be JSON")
    }
    const idToken = (body as { id_token?: unknown } | null)?.id_token
    if (typeof idToken !== "string" || !idToken) {
      return oauthError(400, "invalid_request", "id_token is required")
    }
    await verifyFreshIdToken(
      idToken,
      userId,
      { jwks, issuer: deps.issuer },
      Math.floor(now.getTime() / 1000)
    )
    return json(stateOf(await requestDeletion(deps.db, userId, now, deps.coolingOffDays)))
  } catch (error) {
    if (error instanceof AccountTokenError) {
      return error.status === 401
        ? oauthError(401, "invalid_token", error.message)
        : oauthError(403, "insufficient_user_authentication", error.message)
    }
    throw error
  }
}
