import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { accessConfig, readAccessToken, resetAccessKeyCache, verifyAccess } from "./access"
import {
  ACCESS_AUD,
  ACCESS_TEAM,
  accessKeys,
  baseEnv,
  jwksFetch,
  signAccessJwt,
  type AccessKeys,
} from "./test-support"

let keys: AccessKeys
let forger: AccessKeys

beforeAll(async () => {
  keys = await accessKeys("kid-real")
  // Same kid, different private key: a forged token for a known key ID.
  forger = await accessKeys("kid-real")
})

function requestWith(token: string | null, via: "header" | "cookie" = "header"): Request {
  const headers = new Headers()
  if (token && via === "header") headers.set("cf-access-jwt-assertion", token)
  if (token && via === "cookie") headers.set("cookie", `other=1; CF_Authorization=${token}`)
  return new Request("https://status.test/api/status/v1/admin/incidents", { headers })
}

describe("Access JWT verification", () => {
  let counter: { calls: number }

  beforeEach(() => {
    resetAccessKeyCache()
    counter = { calls: 0 }
    vi.spyOn(globalThis, "fetch").mockImplementation(jwksFetch([keys], counter))
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("accepts a valid allowlisted identity from the header or the cookie", async () => {
    const token = await signAccessJwt(keys)
    expect(await verifyAccess(requestWith(token), baseEnv, Date.now())).toEqual({
      ok: true,
      email: "operator@cognia.test",
    })
    expect(await verifyAccess(requestWith(token, "cookie"), baseEnv, Date.now())).toMatchObject({
      ok: true,
    })
    // JWKS fetched once and cached.
    expect(counter.calls).toBe(1)
  })

  it("matches the allowlist case-insensitively", async () => {
    const token = await signAccessJwt(keys, { email: "Operator@Cognia.TEST" })
    expect(await verifyAccess(requestWith(token), baseEnv, Date.now())).toMatchObject({ ok: true })
  })

  it("denies a missing token", async () => {
    expect(await verifyAccess(requestWith(null), baseEnv, Date.now())).toMatchObject({
      ok: false,
      code: "unauthorized",
    })
  })

  it("denies a forged signature", async () => {
    const token = await signAccessJwt(forger)
    expect(await verifyAccess(requestWith(token), baseEnv, Date.now())).toMatchObject({
      ok: false,
      code: "unauthorized",
      reason: "bad_signature",
    })
  })

  it("denies a tampered payload", async () => {
    const token = await signAccessJwt(keys)
    const [head, , sig] = token.split(".")
    const forgedBody = btoa(
      JSON.stringify({
        iss: ACCESS_TEAM,
        aud: [ACCESS_AUD],
        email: "operator@cognia.test",
        exp: 9e9,
      })
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
    expect(
      await verifyAccess(requestWith(`${head}.${forgedBody}.${sig}`), baseEnv, Date.now())
    ).toMatchObject({
      ok: false,
      code: "unauthorized",
    })
  })

  it("denies the wrong audience, issuer, expiry and not-before", async () => {
    const now = Date.now()
    const nowSeconds = Math.floor(now / 1000)
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ aud: ["another-app"] }, "wrong_audience"],
      [{ iss: "https://evil.cloudflareaccess.com" }, "wrong_issuer"],
      [{ exp: nowSeconds - 120 }, "expired"],
      [{ nbf: nowSeconds + 600 }, "not_yet_valid"],
    ]
    for (const [claims, reason] of cases) {
      const token = await signAccessJwt(keys, claims)
      expect(await verifyAccess(requestWith(token), baseEnv, now)).toMatchObject({
        ok: false,
        code: "unauthorized",
        reason,
      })
    }
  })

  it("tolerates 60 s of clock skew on expiry", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const token = await signAccessJwt(keys, { exp: nowSeconds - 30 })
    expect(await verifyAccess(requestWith(token), baseEnv, Date.now())).toMatchObject({ ok: true })
  })

  it("forbids identities outside the allowlist and tokens without an email", async () => {
    const stranger = await signAccessJwt(keys, { email: "someone@else.test" })
    expect(await verifyAccess(requestWith(stranger), baseEnv, Date.now())).toMatchObject({
      ok: false,
      code: "forbidden",
    })
    const service = await signAccessJwt(keys, { email: undefined, common_name: "svc-token" })
    expect(await verifyAccess(requestWith(service), baseEnv, Date.now())).toMatchObject({
      ok: false,
      code: "forbidden",
      reason: "no_email_identity",
    })
  })

  it("refuses non-RS256 algorithms", async () => {
    const token = await signAccessJwt(keys, {}, { alg: "HS256" })
    expect(await verifyAccess(requestWith(token), baseEnv, Date.now())).toMatchObject({
      reason: "unsupported_alg",
    })
  })

  it("refetches the JWKS once for an unknown kid, then rate-limits refetches", async () => {
    const rotated = await accessKeys("kid-rotated")
    vi.restoreAllMocks()
    let served: AccessKeys[] = [keys]
    vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      jwksFetch(served, counter)(input as RequestInfo)
    )
    const now = Date.now()
    expect(await verifyAccess(requestWith(await signAccessJwt(keys)), baseEnv, now)).toMatchObject({
      ok: true,
    })
    served = [keys, rotated]
    // Within the refetch interval an unknown kid does not trigger a fetch...
    expect(
      await verifyAccess(requestWith(await signAccessJwt(rotated)), baseEnv, now + 1_000)
    ).toMatchObject({
      reason: "unknown_kid",
    })
    expect(counter.calls).toBe(1)
    // ...after it, one refetch picks up the rotated key.
    expect(
      await verifyAccess(requestWith(await signAccessJwt(rotated)), baseEnv, now + 31_000)
    ).toMatchObject({ ok: true })
    expect(counter.calls).toBe(2)
  })

  it("is unavailable, never open, when Access is not configured", async () => {
    const token = await signAccessJwt(keys)
    for (const missing of ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ADMIN_EMAILS"] as const) {
      const env = { ...baseEnv, [missing]: "" }
      expect(await verifyAccess(requestWith(token), env, Date.now())).toMatchObject({
        ok: false,
        code: "unavailable",
      })
    }
    expect(accessConfig({ ...baseEnv, ACCESS_TEAM_DOMAIN: "http://plain.example" })).toBeNull()
  })

  it("is unavailable when the JWKS cannot be fetched", async () => {
    vi.restoreAllMocks()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 500 }))
    expect(
      await verifyAccess(requestWith(await signAccessJwt(keys)), baseEnv, Date.now())
    ).toMatchObject({
      code: "unavailable",
    })
  })

  it("never takes the issuer or JWKS location from the token", async () => {
    const token = await signAccessJwt(
      keys,
      { iss: "https://attacker.example" },
      { jku: "https://attacker.example/certs" }
    )
    expect(await verifyAccess(requestWith(token), baseEnv, Date.now())).toMatchObject({ ok: false })
    const fetched = (
      globalThis.fetch as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.map((call) => String(call[0]))
    expect(fetched.every((url) => url === `${ACCESS_TEAM}/cdn-cgi/access/certs`)).toBe(true)
  })

  it("reads the cookie only when the header is absent", () => {
    expect(readAccessToken(requestWith("abc", "cookie"))).toBe("abc")
    expect(readAccessToken(requestWith(null))).toBeNull()
  })
})
