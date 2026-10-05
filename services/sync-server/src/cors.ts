/**
 * CORS for the official web app: every `/v1/` route answers cross-origin for
 * the exact `WEB_ORIGINS`, never with credentials (bearer tokens and device
 * proofs, no cookies). The server-time header is exposed so a browser client
 * can correct its clock for device proofs.
 */

import { DEVICE_PROOF_HEADER } from "@cognia/sync-protocol"

import { SERVER_TIME_HEADER } from "./http"

const ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS"
const ALLOWED_HEADERS = `authorization, content-type, ${DEVICE_PROOF_HEADER}`
const MAX_AGE_SECONDS = "600"

export function allowedOrigin(request: Request, webOrigins: readonly string[]): string | null {
  const origin = request.headers.get("origin")
  return origin && webOrigins.includes(origin) ? origin : null
}

export function preflightResponse(request: Request, webOrigins: readonly string[]): Response {
  const origin = allowedOrigin(request, webOrigins)
  const headers = new Headers({ vary: "Origin" })
  if (origin) {
    headers.set("access-control-allow-origin", origin)
    headers.set("access-control-allow-methods", ALLOWED_METHODS)
    headers.set("access-control-allow-headers", ALLOWED_HEADERS)
    headers.set("access-control-max-age", MAX_AGE_SECONDS)
  }
  return new Response(null, { status: 204, headers })
}

export function withCors(
  response: Response,
  request: Request,
  webOrigins: readonly string[]
): Response {
  const origin = allowedOrigin(request, webOrigins)
  const headers = new Headers(response.headers)
  headers.set("vary", "Origin")
  if (origin) {
    headers.set("access-control-allow-origin", origin)
    headers.set("access-control-expose-headers", SERVER_TIME_HEADER)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
