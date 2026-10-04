/**
 * The Better Auth routes this Worker offers over HTTP. Everything else under
 * `/api/auth` is a 404 before Better Auth sees it.
 *
 * Better Auth and its plugins mount many routes this deployment must not
 * expose: password sign-up, client and consent management, account linking,
 * the jwt plugin's session token. `disabledPaths` only matches exact paths and
 * library upgrades add routes, so the gate is an allowlist: a route nobody
 * listed here is unreachable. `route-allowlist.test.ts` enumerates the
 * library's endpoints and fails when one of them is neither listed nor
 * refused.
 */

import { AUTH_BASE_PATH } from "./config"

type Method = "GET" | "HEAD" | "POST"

interface AllowedRoute {
  /** Path under `/api/auth`; `:param` matches one segment. */
  path: string
  methods: readonly Method[]
}

export const ALLOWED_AUTH_ROUTES: readonly AllowedRoute[] = [
  // Discovery and keys.
  { path: "/.well-known/openid-configuration", methods: ["GET", "HEAD"] },
  { path: "/.well-known/oauth-authorization-server", methods: ["GET", "HEAD"] },
  { path: "/jwks", methods: ["GET", "HEAD"] },
  // The authorization-code flow for the first-party public clients.
  { path: "/oauth2/authorize", methods: ["GET", "POST"] },
  { path: "/oauth2/token", methods: ["POST"] },
  { path: "/oauth2/revoke", methods: ["POST"] },
  { path: "/oauth2/userinfo", methods: ["GET", "POST"] },
  // The consent page posts its decision here (reached on prompt=consent).
  { path: "/oauth2/consent", methods: ["POST"] },
  { path: "/oauth2/public-client", methods: ["GET"] },
  // RP-initiated logout.
  { path: "/oauth2/end-session", methods: ["GET", "POST"] },
  { path: "/oauth2/end-session/confirm", methods: ["POST"] },
  // Social sign-in and its provider callbacks (Apple returns with a form POST).
  { path: "/sign-in/social", methods: ["POST"] },
  { path: "/callback/:id", methods: ["GET", "POST"] },
]

function matches(pattern: string, path: string): boolean {
  const want = pattern.split("/")
  const got = path.split("/")
  if (want.length !== got.length) return false
  return want.every((segment, index) =>
    segment.startsWith(":") ? got[index]!.length > 0 : segment === got[index]
  )
}

/** Whether a request to `pathname` (absolute, under `/api/auth`) may reach Better Auth. */
export function isAllowedAuthRoute(method: string, pathname: string): boolean {
  if (!pathname.startsWith(`${AUTH_BASE_PATH}/`)) return false
  // Trailing slashes and empty segments are not an alternate spelling.
  const path = pathname.slice(AUTH_BASE_PATH.length)
  if (path.includes("//") || (path.length > 1 && path.endsWith("/"))) return false
  const upper = method.toUpperCase()
  return ALLOWED_AUTH_ROUTES.some(
    (route) => (route.methods as readonly string[]).includes(upper) && matches(route.path, path)
  )
}
