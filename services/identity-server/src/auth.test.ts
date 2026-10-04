import { getMigrations } from "better-auth/db/migration"
import { describe, expect, it } from "vitest"

import {
  authorize,
  call,
  decodeJwt,
  exchangeCode,
  ISSUER,
  NATIVE_REDIRECT,
  pkcePair,
  signedInSession,
  signInAndGetTokens,
  SYNC_AUDIENCE,
  testConfig,
  testEnv,
} from "../test/helpers"
import {
  authOptions,
  isPlaceholderEmail,
  newUserId,
  SUPPORTED_CLAIMS,
  withoutProviderTokens,
} from "./auth"

const USER_ID = /^usr_[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/

describe("schema", () => {
  it("needs nothing the checked-in migrations do not create", async () => {
    const { toBeCreated, toBeAdded } = await getMigrations(authOptions(testConfig(), testEnv.DB))
    expect(toBeCreated.map((table) => table.table)).toEqual([])
    expect(toBeAdded.map((table) => table.table)).toEqual([])
  })
})

describe("discovery", () => {
  it("advertises the issuer, ES256 signing and the identities claim", async () => {
    const doc = (await (await call("/api/auth/.well-known/openid-configuration")).json()) as Record<
      string,
      unknown
    >
    expect(doc.issuer).toBe(ISSUER)
    expect(doc.id_token_signing_alg_values_supported).toEqual(["ES256"])
    expect(doc.claims_supported).toEqual([...SUPPORTED_CLAIMS])
    expect(doc.scopes_supported).toEqual(["openid", "profile", "email", "offline_access"])
    // No dynamic registration is advertised.
    expect(doc.registration_endpoint).toBeUndefined()
  })

  it("publishes ES256 keys with alg and kid", async () => {
    const jwks = (await (await call("/api/auth/jwks")).json()) as { keys: Record<string, string>[] }
    expect(jwks.keys.length).toBeGreaterThan(0)
    for (const key of jwks.keys) {
      expect(key.alg).toBe("ES256")
      expect(key.crv).toBe("P-256")
      expect(key.kid).toBeTruthy()
      expect(key.d).toBeUndefined()
    }
  })
})

describe("the cognia-app public client", () => {
  it("issues an at+jwt for the sync API whose subject is the person's usr_ id", async () => {
    const { userId, tokens } = await signInAndGetTokens()
    expect(userId).toMatch(USER_ID)
    expect(tokens.token_type).toBe("Bearer")
    expect(tokens.expires_in).toBe(900)
    expect(tokens.refresh_token).toBeTruthy()

    const access = decodeJwt(tokens.access_token)
    expect(access.header).toMatchObject({ alg: "ES256", typ: "at+jwt" })
    expect(access.header.kid).toBeTruthy()
    expect(access.payload.iss).toBe(ISSUER)
    expect(access.payload.sub).toBe(userId)
    expect(access.payload.aud).toEqual(expect.arrayContaining([SYNC_AUDIENCE]))
    expect(access.payload.client_id).toBe("cognia-app")
  })

  it("puts the person's name and linked identities in the ID token", async () => {
    const { userId, tokens } = await signInAndGetTokens()
    const id = decodeJwt(tokens.id_token!).payload
    expect(id.sub).toBe(userId)
    expect(id.aud).toBe("cognia-app")
    expect(id.name).toBe("Ada")
    expect(typeof id.auth_time).toBe("number")
    // A test-utils user has no social account yet: an empty list, not a missing claim.
    expect(id.cognia_identities).toEqual([])
    // `email` was not requested.
    expect(id.email).toBeUndefined()
  })

  it("returns through the private-use native callback too", async () => {
    const { tokens } = await signInAndGetTokens({ redirectUri: NATIVE_REDIRECT })
    expect(decodeJwt(tokens.access_token).payload.client_id).toBe("cognia-app")
  })

  it("refuses an unregistered redirect", async () => {
    const { cookie } = await signedInSession()
    const { challenge } = await pkcePair()
    // Never redirected to the unregistered target: the issuer's own error page.
    const landing = await authorize({
      cookie,
      challenge,
      redirectUri: "https://evil.example/callback",
    })
    expect(landing.origin).toBe("https://id.test")
    expect(landing.pathname).toBe("/error")
    expect(landing.searchParams.get("error")).toBe("invalid_redirect")
  })

  it("requires PKCE", async () => {
    const { cookie } = await signedInSession()
    const { challenge } = await pkcePair()
    const callback = await authorize({ cookie, challenge })
    const response = await exchangeCode({
      code: callback.searchParams.get("code")!,
      verifier: "wrong-verifier",
    })
    expect(response.ok).toBe(false)
  })

  it("rotates refresh tokens, revokes them, and refuses a revoked one", async () => {
    const { tokens } = await signInAndGetTokens()
    const refresh = (refreshToken: string) =>
      call("/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: "cognia-app",
          refresh_token: refreshToken,
          resource: SYNC_AUDIENCE,
        }),
      })
    const first = await refresh(tokens.refresh_token!)
    expect(first.status).toBe(200)
    const rotated = (await first.json()) as { refresh_token: string; access_token: string }
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token)
    expect(decodeJwt(rotated.access_token).payload.aud).toEqual(
      expect.arrayContaining([SYNC_AUDIENCE])
    )

    const revoke = await call("/api/auth/oauth2/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: rotated.refresh_token,
        token_type_hint: "refresh_token",
        client_id: "cognia-app",
      }),
    })
    expect(revoke.status).toBe(200)
    const after = await refresh(rotated.refresh_token)
    expect(after.status).toBe(400)
    expect(((await after.json()) as { error: string }).error).toBe("invalid_grant")
  })

  it("serves the identities claim from UserInfo", async () => {
    const { userId, tokens } = await signInAndGetTokens()
    const response = await call("/api/auth/oauth2/userinfo", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    expect(response.status).toBe(200)
    const info = (await response.json()) as Record<string, unknown>
    expect(info.sub).toBe(userId)
    expect(info.cognia_identities).toEqual([])
  })
})

describe("the cognia-web client", () => {
  it("accepts a configured web origin's callback", async () => {
    const { tokens } = await signInAndGetTokens({
      clientId: "cognia-web",
      redirectUri: "https://app.test/logto/callback",
    })
    expect(decodeJwt(tokens.access_token).payload.client_id).toBe("cognia-web")
  })

  it("accepts the local dev origin listed in WEB_ORIGINS", async () => {
    const { tokens } = await signInAndGetTokens({
      clientId: "cognia-web",
      redirectUri: "http://localhost:3000/logto/callback",
    })
    expect(tokens.access_token).toBeTruthy()
  })

  it("refuses an origin that is not configured", async () => {
    const { cookie } = await signedInSession()
    const { challenge } = await pkcePair()
    // Production's origin is not configured in the test environment.
    const landing = await authorize({
      cookie,
      challenge,
      clientId: "cognia-web",
      redirectUri: "https://app.cognia.cn/logto/callback",
    })
    expect(landing.origin).toBe("https://id.test")
    expect(landing.searchParams.get("error")).toBe("invalid_redirect")
  })
})

describe("helpers", () => {
  it("mints usr_ ids with 128 bits of entropy", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newUserId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(/^usr_[0-9a-f]{32}$/)
  })

  it("strips provider tokens from social accounts only", () => {
    expect(
      withoutProviderTokens({
        providerId: "github",
        accessToken: "a",
        refreshToken: "r",
        idToken: "i",
        accountId: "1",
      })
    ).toEqual({
      providerId: "github",
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accountId: "1",
    })
    expect(withoutProviderTokens({ providerId: "credential", password: "hash" })).toEqual({
      providerId: "credential",
      password: "hash",
    })
  })

  it("recognises reserved-domain placeholder emails", () => {
    expect(isPlaceholderEmail("on_x.tk@feishu.users.invalid")).toBe(true)
    expect(isPlaceholderEmail("ada@example.com")).toBe(false)
    expect(isPlaceholderEmail(undefined)).toBe(false)
  })
})
