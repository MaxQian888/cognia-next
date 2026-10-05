/**
 * The sync API's routes (protocol §5.6). Anything not listed is a 404 before
 * authentication; `:id` matches a `req_` id only.
 */

import { isRequestId } from "@cognia/sync-protocol"

export type RouteName =
  | "health"
  | "space"
  | "genesis"
  | "registry.read"
  | "registry.append"
  | "envelopes.self"
  | "envelopes.recovery"
  | "requests.list"
  | "requests.create"
  | "requests.get"
  | "requests.cancel"
  | "requests.nonce"
  | "requests.reveal"
  | "requests.deny"

interface RouteSpec {
  method: "GET" | "POST" | "DELETE"
  path: string
  name: RouteName
}

export const ROUTES: readonly RouteSpec[] = [
  { method: "GET", path: "/v1/health", name: "health" },
  { method: "GET", path: "/v1/space", name: "space" },
  { method: "POST", path: "/v1/space/genesis", name: "genesis" },
  { method: "GET", path: "/v1/registry", name: "registry.read" },
  { method: "POST", path: "/v1/registry", name: "registry.append" },
  { method: "GET", path: "/v1/envelopes/self", name: "envelopes.self" },
  { method: "GET", path: "/v1/envelopes/recovery", name: "envelopes.recovery" },
  { method: "GET", path: "/v1/enroll/requests", name: "requests.list" },
  { method: "POST", path: "/v1/enroll/requests", name: "requests.create" },
  { method: "GET", path: "/v1/enroll/requests/:id", name: "requests.get" },
  { method: "DELETE", path: "/v1/enroll/requests/:id", name: "requests.cancel" },
  { method: "POST", path: "/v1/enroll/requests/:id/nonce", name: "requests.nonce" },
  { method: "POST", path: "/v1/enroll/requests/:id/reveal", name: "requests.reveal" },
  { method: "POST", path: "/v1/enroll/requests/:id/deny", name: "requests.deny" },
]

export interface MatchedRoute {
  name: RouteName
  requestId: string | null
}

export function matchRoute(method: string, pathname: string): MatchedRoute | null {
  const upper = method.toUpperCase()
  const got = pathname.split("/")
  for (const route of ROUTES) {
    if (route.method !== upper) continue
    const want = route.path.split("/")
    if (want.length !== got.length) continue
    let requestId: string | null = null
    const ok = want.every((segment, index) => {
      if (segment !== ":id") return segment === got[index]
      requestId = got[index]!
      return isRequestId(requestId)
    })
    if (ok) return { name: route.name, requestId }
  }
  return null
}

/** Routes that need only the bearer token; every other authenticated route also needs a device proof. */
export const BEARER_ONLY: ReadonlySet<RouteName> = new Set([
  "space",
  "genesis",
  "registry.read",
  "envelopes.recovery",
  "requests.create",
])
