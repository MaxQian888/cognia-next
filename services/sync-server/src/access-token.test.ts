import { describe, expect, it } from "vitest"

import { accessToken, AUDIENCE, ISSUER, newUserId } from "../test/helpers"
import { bearerToken, verifyAccessToken } from "./access-token"
import { createJwksCache, jwksFetcher } from "./jwks"
import { testEnv } from "../test/helpers"

const check = () => ({
  jwks: createJwksCache(jwksFetcher(ISSUER, testEnv.IDENTITY)),
  issuer: ISSUER,
  audience: AUDIENCE,
})

async function refusal(token: string) {
  const error = await verifyAccessToken(token, check()).then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toMatchObject({ status: 401, code: "unauthorized" })
}

describe("bearerToken", () => {
  it("reads a bearer header and nothing else", () => {
    expect(
      bearerToken(new Request("https://x", { headers: { authorization: "Bearer a.b.c" } }))
    ).toBe("a.b.c")
    expect(
      bearerToken(new Request("https://x", { headers: { authorization: "Basic a" } }))
    ).toBeNull()
    expect(bearerToken(new Request("https://x"))).toBeNull()
  })
})

describe("verifyAccessToken", () => {
  it("accepts a sync access token from a Cognia app and returns the person", async () => {
    const userId = newUserId()
    expect(await verifyAccessToken(await accessToken(userId), check())).toBe(userId)
    expect(
      await verifyAccessToken(
        await accessToken(userId, { clientId: null, azp: "cognia-web" }),
        check()
      )
    ).toBe(userId)
  })

  it("refuses other issuers, audiences, token types and clients", async () => {
    const userId = newUserId()
    await refusal(await accessToken(userId, { iss: "https://id.other/api/auth" }))
    await refusal(await accessToken(userId, { aud: "https://other.example" }))
    await refusal(await accessToken(userId, { typ: "JWT" }))
    await refusal(await accessToken(userId, { clientId: "someone-else" }))
    await refusal(await accessToken(userId, { clientId: null }))
    await refusal(await accessToken(userId, { expiresIn: -60 }))
    await refusal(await accessToken("not-a-person"))
    await refusal("not.a.jwt")
  })

  it("refuses a token signed by a key the issuer does not publish", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair
    await refusal(await accessToken(newUserId(), { key: pair.privateKey }))
  })
})
