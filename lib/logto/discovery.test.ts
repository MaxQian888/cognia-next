import { discoverLogtoEndpoints } from "./discovery"

function mockFetch(json: unknown, ok = true): typeof fetch {
  return jest.fn(
    async () => new Response(JSON.stringify(json), { status: ok ? 200 : 500 })
  ) as unknown as typeof fetch
}

const FULL_DOC = {
  issuer: "https://logto.test/oidc",
  authorization_endpoint: "https://logto.test/oidc/auth",
  token_endpoint: "https://logto.test/oidc/token",
  jwks_uri: "https://logto.test/oidc/jwks",
  end_session_endpoint: "https://logto.test/oidc/session/end",
  revocation_endpoint: "https://logto.test/oidc/token/revocation",
}

describe("discoverLogtoEndpoints", () => {
  it("fetches the discovery document and returns the endpoints", async () => {
    const fetchImpl = mockFetch(FULL_DOC)
    const ep = await discoverLogtoEndpoints("https://logto.test/oidc", fetchImpl)
    expect(ep.issuer).toBe("https://logto.test/oidc")
    expect(ep.authorizationEndpoint).toBe("https://logto.test/oidc/auth")
    expect(ep.tokenEndpoint).toBe("https://logto.test/oidc/token")
    expect(ep.jwksUri).toBe("https://logto.test/oidc/jwks")
    expect(ep.endSessionEndpoint).toBe("https://logto.test/oidc/session/end")
    expect(ep.revocationEndpoint).toBe("https://logto.test/oidc/token/revocation")
    const url = (fetchImpl as jest.Mock).mock.calls[0][0]
    expect(url).toBe("https://logto.test/oidc/.well-known/openid-configuration")
  })

  it("normalizes a trailing slash on the issuer", async () => {
    const fetchImpl = mockFetch(FULL_DOC)
    await discoverLogtoEndpoints("https://logto.test/oidc/", fetchImpl)
    expect((fetchImpl as jest.Mock).mock.calls[0][0]).toBe(
      "https://logto.test/oidc/.well-known/openid-configuration"
    )
  })

  it("falls back to the base issuer when the doc omits `issuer`", async () => {
    const fetchImpl = mockFetch({
      authorization_endpoint: "https://logto.test/oidc/auth",
      token_endpoint: "https://logto.test/oidc/token",
    })
    const ep = await discoverLogtoEndpoints("https://logto.test/oidc", fetchImpl)
    expect(ep.issuer).toBe("https://logto.test/oidc")
    expect(ep.jwksUri).toBeUndefined()
  })

  it("throws when discovery returns a non-2xx status", async () => {
    const fetchImpl = mockFetch({}, false)
    await expect(discoverLogtoEndpoints("https://logto.test/oidc", fetchImpl)).rejects.toThrow(
      /discovery failed/i
    )
  })

  it("throws when required endpoints are missing", async () => {
    const fetchImpl = mockFetch({ issuer: "https://logto.test/oidc" })
    await expect(discoverLogtoEndpoints("https://logto.test/oidc", fetchImpl)).rejects.toThrow(
      /authorization_endpoint or token_endpoint/i
    )
  })
})
