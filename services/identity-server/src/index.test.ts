import { describe, expect, it } from "vitest"

import {
  authorize,
  call,
  pkcePair,
  signedInSession,
  signInAndGetTokens,
  testEnv,
} from "../test/helpers"
import { handleRequest } from "./index"

describe("identity worker", () => {
  it("serves OIDC discovery for its issuer", async () => {
    const response = await call("/api/auth/.well-known/openid-configuration")
    expect(response.status).toBe(200)
    const doc = (await response.json()) as Record<string, unknown>
    expect(doc.issuer).toBe("https://id.test/api/auth")
    expect(doc.jwks_uri).toBe("https://id.test/api/auth/jwks")
  })

  it("answers 503 instead of issuing tokens when misconfigured", async () => {
    const response = await handleRequest(new Request("https://id.test/api/auth/jwks"), {
      ...testEnv,
      BETTER_AUTH_SECRETS: "1:short",
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: "server_misconfigured" })
  })

  it("has nothing at unknown paths", async () => {
    expect((await call("/")).status).toBe(404)
    expect((await call("/api/other")).status).toBe(404)
    expect((await call("/sign-in", { method: "POST" })).status).toBe(404)
    expect((await call("/anything", { method: "OPTIONS" })).status).toBe(404)
  })

  it("sends an unauthenticated authorize request to the hosted sign-in page", async () => {
    const { challenge } = await pkcePair()
    const landing = await authorize({ challenge, extra: { provider: "github" } })
    expect(landing.pathname).toBe("/sign-in")
    expect(landing.searchParams.get("provider")).toBe("github")
  })

  it("ends the browser session on RP-initiated logout", async () => {
    const session = await signedInSession()
    const { tokens } = await signInAndGetTokens({ cookie: session.cookie })
    const params = new URLSearchParams({ id_token_hint: tokens.id_token!, client_id: "cognia-app" })
    const logout = await call(`/api/auth/oauth2/end-session?${params}`, {
      headers: { cookie: session.cookie },
      redirect: "manual",
    })
    expect(logout.status).toBeLessThan(500)
    // The old cookie no longer signs anyone in: authorize asks for a sign-in again.
    const { challenge } = await pkcePair()
    const landing = await authorize({ cookie: session.cookie, challenge })
    expect(landing.pathname).toBe("/sign-in")
  })

  it("rate-limits social sign-in per client address", async () => {
    const attempt = () =>
      call("/api/auth/sign-in/social", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.7",
          origin: "https://id.test",
        },
        body: JSON.stringify({ provider: "github", callbackURL: "/sign-in" }),
      })
    const statuses: number[] = []
    for (let i = 0; i < 12; i++) statuses.push((await attempt()).status)
    expect(statuses.slice(0, 10).every((status) => status !== 429)).toBe(true)
    expect(statuses.at(-1)).toBe(429)
  })
})
