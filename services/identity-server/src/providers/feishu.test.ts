import { afterEach, describe, expect, it, vi } from "vitest"

import {
  call,
  decodeJwt,
  exchangeCode,
  LOOPBACK_REDIRECT,
  pkcePair,
  SYNC_AUDIENCE,
  testEnv,
} from "../../test/helpers"
import {
  FEISHU_AUTHORIZE_URL,
  FEISHU_TOKEN_URL,
  FEISHU_USER_INFO_URL,
  feishuAccountSubject,
  feishuPlaceholderEmail,
  feishuProviderConfig,
} from "./feishu"

/** A minimal cookie jar: name → value from every Set-Cookie seen. */
class Jar {
  private cookies = new Map<string, string>()
  take(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";")
      const index = pair!.indexOf("=")
      const name = pair!.slice(0, index).trim()
      const value = pair!.slice(index + 1).trim()
      if (/max-age=0/i.test(header) || value === "") this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }
  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
  }
}

function stubFeishu(user: Record<string, unknown>) {
  const calls: { url: string; body?: unknown }[] = []
  const real = globalThis.fetch
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url === FEISHU_TOKEN_URL) {
      calls.push({ url, body: JSON.parse(String(init?.body)) })
      return Response.json({
        code: 0,
        access_token: "u-feishu",
        refresh_token: "ur-feishu",
        expires_in: 7200,
        token_type: "Bearer",
        scope: "",
      })
    }
    if (url === FEISHU_USER_INFO_URL) {
      calls.push({ url })
      return Response.json({ code: 0, msg: "success", data: user })
    }
    return real(input, init)
  })
  return calls
}

async function runFeishuSignIn(user: Record<string, unknown>) {
  const calls = stubFeishu(user)
  const jar = new Jar()
  const { verifier, challenge } = await pkcePair()
  const params = new URLSearchParams({
    response_type: "code",
    client_id: "cognia-app",
    redirect_uri: LOOPBACK_REDIRECT,
    scope: "openid profile offline_access",
    state: "app-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: SYNC_AUDIENCE,
    provider: "feishu",
  })
  // 1. No session yet: the authorize request lands on the login page, signed.
  const authorize = await call(`/api/auth/oauth2/authorize?${params}`, { redirect: "manual" })
  expect(authorize.status).toBe(302)
  const login = new URL(authorize.headers.get("location")!, "https://id.test")
  expect(login.pathname).toBe("/sign-in")
  expect(login.searchParams.get("provider")).toBe("feishu")
  expect(login.searchParams.get("sig")).toBeTruthy()

  // 2. The login page posts the signed query to start the Feishu sign-in.
  const start = await call("/api/auth/sign-in/social", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://id.test" },
    body: JSON.stringify({
      provider: "feishu",
      callbackURL: "/sign-in",
      oauth_query: login.search.slice(1),
    }),
  })
  expect(start.status).toBe(200)
  jar.take(start)
  const feishuUrl = new URL(((await start.json()) as { url: string }).url)
  expect(`${feishuUrl.origin}${feishuUrl.pathname}`).toBe(FEISHU_AUTHORIZE_URL)
  expect(feishuUrl.searchParams.get("client_id")).toBe("cli_test_feishu")
  expect(feishuUrl.searchParams.get("redirect_uri")).toBe(
    "https://id.test/api/auth/callback/feishu"
  )
  expect(feishuUrl.searchParams.get("code_challenge_method")).toBe("S256")

  // 3. Feishu calls back; Better Auth signs the person in and resumes the authorization.
  const callback = await call(
    `/api/auth/callback/feishu?code=feishu-code&state=${feishuUrl.searchParams.get("state")}`,
    {
      // A top-level browser navigation, as Feishu's redirect is.
      headers: { cookie: jar.header(), accept: "text/html", "sec-fetch-mode": "navigate" },
      redirect: "manual",
    }
  )
  expect(callback.status).toBe(302)
  const back = new URL(callback.headers.get("location")!, "https://id.test")
  expect(`${back.origin}${back.pathname}`).toBe(LOOPBACK_REDIRECT)
  expect(back.searchParams.get("state")).toBe("app-state")

  const tokens = (await (
    await exchangeCode({ code: back.searchParams.get("code")!, verifier })
  ).json()) as {
    access_token: string
    id_token: string
  }
  return { calls, tokens }
}

describe("Feishu sign-in", () => {
  afterEach(() => vi.restoreAllMocks())

  it("signs in through the v2 token endpoint, keyed on tenant_key and union_id", async () => {
    const { calls, tokens } = await runFeishuSignIn({
      name: "飞书用户",
      avatar_url: "https://example.test/a.png",
      open_id: "ou_per_app",
      union_id: "on_union_1",
      tenant_key: "tk_1",
      email: "real@example.com",
    })

    // The v2 exchange is JSON and carries the PKCE verifier.
    const exchange = calls.find((entry) => entry.url === FEISHU_TOKEN_URL)!.body as Record<
      string,
      string
    >
    expect(exchange).toMatchObject({
      grant_type: "authorization_code",
      client_id: "cli_test_feishu",
      code: "feishu-code",
    })
    expect(exchange.code_verifier).toBeTruthy()

    const id = decodeJwt(tokens.id_token).payload
    expect(id.name).toBe("飞书用户")
    expect(id.cognia_identities).toEqual([
      { provider: "lark", tenant: "tk_1", subject: "on_union_1" },
    ])

    const account = await testEnv.DB.prepare(
      'SELECT "accountId", "accessToken", "refreshToken", "idToken", "userId" FROM "account" WHERE "providerId" = ? AND "accountId" = ?'
    )
      .bind("feishu", feishuAccountSubject("tk_1", "on_union_1"))
      .first<Record<string, string | null>>()
    expect(account).not.toBeNull()
    // The issuer keeps who the person is, never their Feishu tokens.
    expect(account!.accessToken).toBeNull()
    expect(account!.refreshToken).toBeNull()
    expect(account!.idToken).toBeNull()
    expect(account!.userId).toBe(decodeJwt(tokens.access_token).payload.sub)

    // The real address is not trusted; the placeholder is, and is unverified.
    const user = await testEnv.DB.prepare(
      'SELECT "email", "emailVerified" FROM "user" WHERE "id" = ?'
    )
      .bind(account!.userId)
      .first<{ email: string; emailVerified: number }>()
    expect(user).toEqual({ email: feishuPlaceholderEmail("tk_1", "on_union_1"), emailVerified: 0 })
  })

  it("signs the same person into the same account the second time", async () => {
    const person = { name: "Grace", union_id: "on_union_2", tenant_key: "tk_1", open_id: "ou_a" }
    const first = await runFeishuSignIn(person)
    vi.restoreAllMocks()
    // Another bot app of the same tenant would carry another open_id; the union id decides.
    const second = await runFeishuSignIn({ ...person, open_id: "ou_b" })
    expect(decodeJwt(second.tokens.access_token).payload.sub).toBe(
      decodeJwt(first.tokens.access_token).payload.sub
    )
  })
})

describe("feishuProviderConfig", () => {
  const credentials = { appId: "cli_x", appSecret: "secret" }

  it("refuses a profile without a union id or tenant", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ code: 0, data: { open_id: "ou_only" } }))
    const provider = feishuProviderConfig(credentials, fetchImpl as unknown as typeof fetch)
    expect(await provider.getUserInfo({ accessToken: "u" })).toBeNull()
    expect(await provider.getUserInfo({})).toBeNull()
  })

  it("surfaces a failed token exchange without echoing secrets", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ code: 20050, error: "invalid_grant" }))
    const provider = feishuProviderConfig(credentials, fetchImpl as unknown as typeof fetch)
    await expect(
      provider.getToken({ code: "c", redirectURI: "https://id.test/cb" })
    ).rejects.toThrow(/20050 invalid_grant/)
    await expect(
      provider.getToken({ code: "c", redirectURI: "https://id.test/cb" })
    ).rejects.not.toThrow(/secret/)
  })

  it("never returns the Feishu refresh token to Better Auth", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ code: 0, access_token: "u", refresh_token: "ur", scope: "a b" })
    )
    const provider = feishuProviderConfig(credentials, fetchImpl as unknown as typeof fetch)
    const tokens = await provider.getToken({
      code: "c",
      redirectURI: "https://id.test/cb",
      codeVerifier: "v",
    })
    expect(tokens).toEqual({ tokenType: "Bearer", accessToken: "u", scopes: ["a", "b"] })
  })

  it("lower-cases the placeholder and keeps it on the reserved TLD", () => {
    expect(feishuPlaceholderEmail("TK", "ON_X")).toBe("on_x.tk@feishu.users.invalid")
  })
})
