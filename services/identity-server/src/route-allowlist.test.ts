import { describe, expect, it } from "vitest"

import { call, signInAndGetTokens, testConfig, testEnv } from "../test/helpers"
import { createAuth } from "./auth"
import { ALLOWED_AUTH_ROUTES, isAllowedAuthRoute } from "./route-allowlist"

type Endpoint = {
  path?: string
  options?: { method?: string | string[]; metadata?: { SERVER_ONLY?: boolean } }
}

function libraryEndpoints(): { path: string; methods: string[] }[] {
  const auth = createAuth(testConfig(), testEnv.DB)
  return Object.values(auth.api as unknown as Record<string, Endpoint>)
    .filter((endpoint) => typeof endpoint?.path === "string")
    .map((endpoint) => {
      const method = endpoint.options?.method ?? "GET"
      return {
        path: endpoint.path!,
        methods: (Array.isArray(method) ? method : [method]).map(String),
      }
    })
}

describe("isAllowedAuthRoute", () => {
  it("allows the OAuth flow and social sign-in", () => {
    expect(isAllowedAuthRoute("GET", "/api/auth/oauth2/authorize")).toBe(true)
    expect(isAllowedAuthRoute("POST", "/api/auth/oauth2/token")).toBe(true)
    expect(isAllowedAuthRoute("POST", "/api/auth/sign-in/social")).toBe(true)
    expect(isAllowedAuthRoute("GET", "/api/auth/callback/feishu")).toBe(true)
    expect(isAllowedAuthRoute("POST", "/api/auth/callback/apple")).toBe(true)
    expect(isAllowedAuthRoute("head", "/api/auth/jwks")).toBe(true)
  })

  it("refuses wrong methods, other paths and alternate spellings", () => {
    expect(isAllowedAuthRoute("GET", "/api/auth/oauth2/token")).toBe(false)
    expect(isAllowedAuthRoute("POST", "/api/auth/sign-in/email")).toBe(false)
    expect(isAllowedAuthRoute("POST", "/api/auth/oauth2/create-client")).toBe(false)
    expect(isAllowedAuthRoute("GET", "/api/auth/callback/")).toBe(false)
    expect(isAllowedAuthRoute("GET", "/api/auth/callback/a/b")).toBe(false)
    expect(isAllowedAuthRoute("POST", "/api/auth/oauth2/token/")).toBe(false)
    expect(isAllowedAuthRoute("POST", "/api/auth//oauth2/token")).toBe(false)
    expect(isAllowedAuthRoute("GET", "/other/jwks")).toBe(false)
  })
})

describe("the allowlist against the library", () => {
  it("names only routes Better Auth actually serves", () => {
    const endpoints = libraryEndpoints()
    for (const route of ALLOWED_AUTH_ROUTES) {
      const served = endpoints.find((endpoint) => endpoint.path === route.path)
      expect(served, `${route.path} is not a Better Auth route`).toBeDefined()
      for (const method of route.methods.filter((m) => m !== "HEAD")) {
        expect(served!.methods, `${route.path} does not accept ${method}`).toContain(method)
      }
    }
  })

  it("leaves every other library route unreachable over HTTP", async () => {
    const allowed = new Set(ALLOWED_AUTH_ROUTES.map((route) => route.path))
    const refused = libraryEndpoints().filter((endpoint) => !allowed.has(endpoint.path))
    // Upgrades add routes; whatever they are, they start out refused.
    expect(refused.length).toBeGreaterThan(20)
    for (const endpoint of refused) {
      for (const method of endpoint.methods) {
        const path = `/api/auth${endpoint.path.replace(/:[^/]+/g, "x")}`
        const response = await call(path, { method, ...(method === "GET" ? {} : { body: "{}" }) })
        expect(response.status, `${method} ${path}`).toBe(404)
      }
    }
  })

  it("keeps client management closed to a signed-in person", async () => {
    const { tokens } = await signInAndGetTokens()
    for (const path of [
      "/api/auth/oauth2/create-client",
      "/api/auth/oauth2/register",
      "/api/auth/token",
    ]) {
      const response = await call(path, {
        method: path.endsWith("/token") ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${tokens.access_token}`,
          "content-type": "application/json",
        },
        ...(path.endsWith("/token")
          ? {}
          : { body: JSON.stringify({ redirect_uris: ["https://evil.example"] }) }),
      })
      expect(response.status, path).toBe(404)
    }
  })
})
