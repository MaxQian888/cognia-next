import { describe, expect, it } from "vitest"

import { call } from "../test/helpers"
import { allowedOrigin, isCorsPath, preflightResponse, withCors } from "./cors"

const ORIGINS = ["https://app.test", "http://localhost:3000"]

describe("cors helpers", () => {
  it("answers a preflight only for a configured origin", () => {
    const allowed = preflightResponse(
      new Request("https://id.test/api/auth/oauth2/token", {
        method: "OPTIONS",
        headers: { origin: "https://app.test" },
      }),
      ORIGINS
    )
    expect(allowed.status).toBe(204)
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.test")
    expect(allowed.headers.get("access-control-allow-headers")).toBe("authorization, content-type")
    expect(allowed.headers.get("access-control-allow-credentials")).toBeNull()

    const foreign = preflightResponse(
      new Request("https://id.test/api/auth/oauth2/token", {
        method: "OPTIONS",
        headers: { origin: "https://evil.example" },
      }),
      ORIGINS
    )
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull()
    expect(foreign.headers.get("vary")).toBe("Origin")
  })

  it("adds the origin to a response and keeps an existing Vary", () => {
    const response = withCors(
      new Response("{}", { headers: { vary: "Accept-Encoding" } }),
      new Request("https://id.test/x", { headers: { origin: "http://localhost:3000" } }),
      ORIGINS
    )
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    expect(response.headers.get("vary")).toBe("Accept-Encoding, Origin")
  })

  it("matches origins exactly", () => {
    const at = (origin: string) => new Request("https://id.test/x", { headers: { origin } })
    expect(allowedOrigin(at("https://app.test"), ORIGINS)).toBe("https://app.test")
    expect(allowedOrigin(at("https://app.test.evil.example"), ORIGINS)).toBeNull()
    expect(allowedOrigin(at("http://app.test"), ORIGINS)).toBeNull()
    expect(allowedOrigin(new Request("https://id.test/x"), ORIGINS)).toBeNull()
  })

  it("covers only the routes a browser SPA calls", () => {
    expect(isCorsPath("/api/auth/oauth2/token")).toBe(true)
    expect(isCorsPath("/api/account/deletion")).toBe(true)
    expect(isCorsPath("/api/auth/oauth2/authorize")).toBe(false)
    expect(isCorsPath("/api/auth/sign-in/social")).toBe(false)
  })
})

describe("cors through the worker", () => {
  it("lets the web app read the JWKS and refuses a preflight on a non-CORS route", async () => {
    const jwks = await call("/api/auth/jwks", { headers: { origin: "https://app.test" } })
    expect(jwks.headers.get("access-control-allow-origin")).toBe("https://app.test")
    const preflight = await call("/api/auth/oauth2/token", {
      method: "OPTIONS",
      headers: { origin: "https://app.test", "access-control-request-method": "POST" },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.test")
    const other = await call("/api/auth/sign-in/social", {
      method: "OPTIONS",
      headers: { origin: "https://app.test" },
    })
    expect(other.status).toBe(404)
  })
})
