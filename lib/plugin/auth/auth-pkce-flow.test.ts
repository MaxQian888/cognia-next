import { runPkceAuthFlow, type PkceFlowConfig } from "./auth-pkce-flow"

function baseConfig(over?: Partial<PkceFlowConfig>): PkceFlowConfig {
  return {
    authorizeUrl: "https://auth.example.com/authorize",
    tokenUrl: "https://auth.example.com/token",
    clientId: "client-123",
    scopes: ["repo", "user"],
    redirectUri: "http://127.0.0.1:9999/callback",
    state: "fixed-state",
    openUrl: jest.fn(),
    waitForCode: jest.fn(async () => ({ code: "the-code", state: "fixed-state" })),
    fetchImpl: jest.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: "tok", refresh_token: "ref", expires_in: 3600 }),
          {
            status: 200,
          }
        )
    ) as unknown as typeof fetch,
    ...over,
  }
}

describe("runPkceAuthFlow", () => {
  it("builds an authorize URL with PKCE params and opens it", async () => {
    const config = baseConfig()
    await runPkceAuthFlow(config)
    const opened = (config.openUrl as jest.Mock).mock.calls[0][0] as string
    const url = new URL(opened)
    expect(url.origin + url.pathname).toBe("https://auth.example.com/authorize")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe("client-123")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("code_challenge")).toBeTruthy()
    expect(url.searchParams.get("state")).toBe("fixed-state")
    expect(url.searchParams.get("scope")).toBe("repo user")
  })

  it("exchanges the code for tokens", async () => {
    const config = baseConfig()
    const result = await runPkceAuthFlow(config)
    expect(result.accessToken).toBe("tok")
    expect(result.refreshToken).toBe("ref")
    expect(result.expiresAt).toBeGreaterThan(0)
    const fetchMock = config.fetchImpl as jest.Mock
    const [tokenUrl, init] = fetchMock.mock.calls[0]
    expect(tokenUrl).toBe("https://auth.example.com/token")
    expect(init.body as string).toContain("grant_type=authorization_code")
    expect(init.body as string).toContain("code=the-code")
    expect(init.body as string).toContain("code_verifier=")
  })

  it("throws on a state mismatch (CSRF guard)", async () => {
    const config = baseConfig({
      waitForCode: jest.fn(async () => ({ code: "c", state: "WRONG" })),
    })
    await expect(runPkceAuthFlow(config)).rejects.toThrow(/state mismatch/)
  })

  it("throws when the token endpoint fails", async () => {
    const config = baseConfig({
      fetchImpl: jest.fn(
        async () => new Response("nope", { status: 400 })
      ) as unknown as typeof fetch,
    })
    await expect(runPkceAuthFlow(config)).rejects.toThrow(/token exchange failed/)
  })

  it("throws when the response lacks an access_token", async () => {
    const config = baseConfig({
      fetchImpl: jest.fn(
        async () => new Response(JSON.stringify({ token_type: "bearer" }), { status: 200 })
      ) as unknown as typeof fetch,
    })
    await expect(runPkceAuthFlow(config)).rejects.toThrow(/missing access_token/)
  })

  it("merges extra authorize params", async () => {
    const config = baseConfig({ extraAuthParams: { access_type: "offline" } })
    await runPkceAuthFlow(config)
    const opened = (config.openUrl as jest.Mock).mock.calls[0][0] as string
    expect(new URL(opened).searchParams.get("access_type")).toBe("offline")
  })

  it("generates a random state when none is supplied (and the callback echoes it)", async () => {
    let issuedState = ""
    const config = baseConfig({
      state: undefined,
      waitForCode: jest.fn(async ({ state }) => {
        issuedState = state
        return { code: "c", state }
      }),
    })
    const result = await runPkceAuthFlow(config)
    expect(issuedState).toBeTruthy()
    expect(result.accessToken).toBe("tok")
  })

  it("handles a token response without refresh_token / expires_in", async () => {
    const config = baseConfig({
      fetchImpl: jest.fn(
        async () => new Response(JSON.stringify({ access_token: "tok" }), { status: 200 })
      ) as unknown as typeof fetch,
    })
    const result = await runPkceAuthFlow(config)
    expect(result.accessToken).toBe("tok")
    expect(result.refreshToken).toBeUndefined()
    expect(result.expiresAt).toBeUndefined()
  })
})
