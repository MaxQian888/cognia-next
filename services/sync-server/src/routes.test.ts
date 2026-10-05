import { describe, expect, it } from "vitest"

import { BEARER_ONLY, ROUTES, matchRoute } from "./routes"

const REQ = `req_${"0".repeat(26)}`

describe("matchRoute", () => {
  it("matches every listed route", () => {
    for (const route of ROUTES) {
      const path = route.path.replace(":id", REQ)
      expect(matchRoute(route.method, path)).toEqual({
        name: route.name,
        requestId: route.path.includes(":id") ? REQ : null,
      })
    }
  })

  it("refuses other methods, trailing slashes, unknown paths and non-request ids", () => {
    expect(matchRoute("PUT", "/v1/space")).toBeNull()
    expect(matchRoute("GET", "/v1/space/")).toBeNull()
    expect(matchRoute("GET", "/v1/spaces")).toBeNull()
    expect(matchRoute("GET", "/v1/enroll/requests/dev_123")).toBeNull()
    expect(matchRoute("GET", `/v1/enroll/requests/${REQ}/x`)).toBeNull()
    expect(matchRoute("get", "/v1/space")).toEqual({ name: "space", requestId: null })
  })

  it("asks a device proof on every route but the person-level ones", () => {
    expect([...BEARER_ONLY].sort()).toEqual([
      "envelopes.recovery",
      "genesis",
      "registry.read",
      "requests.create",
      "space",
    ])
  })
})
