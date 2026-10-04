/**
 * CORS for the official web app (ADR-0215 §2). Better Auth emits none.
 *
 * A browser SPA on one of `WEB_ORIGINS` exchanges codes, refreshes and revokes
 * tokens, reads UserInfo and the JWKS, and manages account deletion across
 * origins. Only those routes answer cross-origin, only for those exact
 * origins, and never with credentials: the SPA authenticates with PKCE and
 * bearer tokens, not with this site's cookies.
 */

import { AUTH_BASE_PATH } from "./config"

export const ACCOUNT_DELETION_PATH = "/api/account/deletion"

const CORS_PATHS = new Set([
  `${AUTH_BASE_PATH}/oauth2/token`,
  `${AUTH_BASE_PATH}/oauth2/revoke`,
  `${AUTH_BASE_PATH}/oauth2/userinfo`,
  `${AUTH_BASE_PATH}/jwks`,
  `${AUTH_BASE_PATH}/.well-known/openid-configuration`,
  `${AUTH_BASE_PATH}/.well-known/oauth-authorization-server`,
  ACCOUNT_DELETION_PATH,
])

const ALLOWED_METHODS = "GET, POST, DELETE, OPTIONS"
const ALLOWED_HEADERS = "authorization, content-type"
const MAX_AGE_SECONDS = "600"

export function isCorsPath(pathname: string): boolean {
  return CORS_PATHS.has(pathname)
}

/** The request's origin when it is one of the configured web origins, else null. */
export function allowedOrigin(request: Request, webOrigins: readonly string[]): string | null {
  const origin = request.headers.get("origin")
  return origin && webOrigins.includes(origin) ? origin : null
}

/** Answer a preflight for a CORS path. A foreign origin gets no CORS headers. */
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

/** Add the CORS headers to a response for an allowed origin. */
export function withCors(
  response: Response,
  request: Request,
  webOrigins: readonly string[]
): Response {
  const origin = allowedOrigin(request, webOrigins)
  const headers = new Headers(response.headers)
  const vary = headers.get("vary")
  if (!vary?.split(",").some((value) => value.trim().toLowerCase() === "origin")) {
    headers.set("vary", vary ? `${vary}, Origin` : "Origin")
  }
  if (origin) headers.set("access-control-allow-origin", origin)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
