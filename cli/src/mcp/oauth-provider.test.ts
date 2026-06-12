/**
 * @jest-environment node
 */
import { createMcpOAuthProvider } from "./oauth-provider"
import { mcpAuthPath, type McpAuthFs } from "./oauth-store"

function memFs(): McpAuthFs & { files: Record<string, string> } {
  const files: Record<string, string> = {}
  return {
    files,
    exists: (p) => p in files,
    readText: (p) => files[p],
    writeText: (p, data) => {
      files[p] = data
    },
  }
}

const HOME = "/home/.cognia"

function make(over: Partial<Parameters<typeof createMcpOAuthProvider>[0]> = {}) {
  const fs = memFs()
  const redirects: URL[] = []
  const provider = createMcpOAuthProvider({
    home: HOME,
    serverName: "linear",
    redirectUrl: "http://127.0.0.1:9000/callback",
    state: "state-123",
    onRedirect: (u) => {
      redirects.push(u)
    },
    fs,
    ...over,
  })
  return { provider, fs, redirects }
}

describe("createMcpOAuthProvider", () => {
  it("exposes redirectUrl, state, and a PKCE public-client metadata document", () => {
    const { provider } = make({ scope: "read write" })
    expect(provider.redirectUrl).toBe("http://127.0.0.1:9000/callback")
    expect(provider.state?.()).toBe("state-123")
    expect(provider.clientMetadata).toMatchObject({
      client_name: "Cognia CLI",
      redirect_uris: ["http://127.0.0.1:9000/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "read write",
    })
  })

  it("persists and reloads tokens through the store", () => {
    const { provider, fs } = make()
    expect(provider.tokens()).toBeUndefined()
    provider.saveTokens({ access_token: "tok", token_type: "bearer" } as never)
    expect(provider.tokens()).toEqual({ access_token: "tok", token_type: "bearer" })
    expect(JSON.parse(fs.files[mcpAuthPath(HOME)]).linear.tokens.access_token).toBe("tok")
  })

  it("saves the code verifier and clears it once tokens arrive", () => {
    const { provider } = make()
    provider.saveCodeVerifier("verifier-xyz")
    expect(provider.codeVerifier()).toBe("verifier-xyz")
    provider.saveTokens({ access_token: "t" } as never)
    expect(() => provider.codeVerifier()).toThrow(/code verifier/)
  })

  it("persists dynamically-registered client information", () => {
    const { provider } = make()
    provider.saveClientInformation?.({ client_id: "cid", client_secret: "sec" } as never)
    expect(provider.clientInformation()).toEqual({ client_id: "cid", client_secret: "sec" })
  })

  it("routes redirectToAuthorization through onRedirect", () => {
    const { provider, redirects } = make()
    const url = new URL("https://auth.example.com/authorize?x=1")
    provider.redirectToAuthorization(url)
    expect(redirects).toEqual([url])
  })
})
