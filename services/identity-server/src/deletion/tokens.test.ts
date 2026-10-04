import type { JSONWebKeySet } from "jose"
import { describe, expect, it } from "vitest"

import { call, ISSUER, signInAndGetTokens, SYNC_AUDIENCE } from "../../test/helpers"
import {
  AccountTokenError,
  bearerToken,
  FRESH_AUTH_SECONDS,
  verifyAccessToken,
  verifyFreshIdToken,
} from "./tokens"

async function jwks(): Promise<JSONWebKeySet> {
  return (await (await call("/api/auth/jwks")).json()) as JSONWebKeySet
}

describe("bearerToken", () => {
  it("reads a bearer token and nothing else", () => {
    expect(
      bearerToken(new Request("https://x", { headers: { authorization: "Bearer abc.def-ghi" } }))
    ).toBe("abc.def-ghi")
    expect(
      bearerToken(new Request("https://x", { headers: { authorization: "Basic abc" } }))
    ).toBeNull()
    expect(bearerToken(new Request("https://x"))).toBeNull()
  })
})

describe("verifyAccessToken", () => {
  it("returns the person's usr_ id", async () => {
    const { userId, tokens } = await signInAndGetTokens()
    expect(
      await verifyAccessToken(tokens.access_token, {
        jwks: await jwks(),
        issuer: ISSUER,
        audience: SYNC_AUDIENCE,
      })
    ).toBe(userId)
  })

  it("refuses an ID token, another audience and another issuer", async () => {
    const { tokens } = await signInAndGetTokens()
    const keys = await jwks()
    await expect(
      verifyAccessToken(tokens.id_token!, { jwks: keys, issuer: ISSUER, audience: SYNC_AUDIENCE })
    ).rejects.toThrow(AccountTokenError)
    await expect(
      verifyAccessToken(tokens.access_token, {
        jwks: keys,
        issuer: ISSUER,
        audience: "https://other.example",
      })
    ).rejects.toThrow(AccountTokenError)
    await expect(
      verifyAccessToken(tokens.access_token, {
        jwks: keys,
        issuer: "https://elsewhere/api/auth",
        audience: SYNC_AUDIENCE,
      })
    ).rejects.toThrow(AccountTokenError)
  })
})

describe("verifyFreshIdToken", () => {
  it("accepts a sign-in from just now by the same person", async () => {
    const { userId, tokens } = await signInAndGetTokens()
    await expect(
      verifyFreshIdToken(tokens.id_token!, userId, { jwks: await jwks(), issuer: ISSUER })
    ).resolves.toBeUndefined()
  })

  it("refuses a stale sign-in, someone else's token and an access token", async () => {
    const { userId, tokens } = await signInAndGetTokens()
    const keys = await jwks()
    const later = Math.floor(Date.now() / 1000) + FRESH_AUTH_SECONDS + 60
    await expect(
      verifyFreshIdToken(tokens.id_token!, userId, { jwks: keys, issuer: ISSUER }, later)
    ).rejects.toMatchObject({
      status: 403,
    })
    await expect(
      verifyFreshIdToken(tokens.id_token!, "usr_someoneelse", { jwks: keys, issuer: ISSUER })
    ).rejects.toMatchObject({
      status: 403,
    })
    await expect(
      verifyFreshIdToken(tokens.access_token, userId, { jwks: keys, issuer: ISSUER })
    ).rejects.toMatchObject({
      status: 401,
    })
  })
})
