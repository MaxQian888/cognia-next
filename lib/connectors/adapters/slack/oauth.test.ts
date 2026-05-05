import { buildSlackOAuthUrl } from "./oauth"

describe("buildSlackOAuthUrl", () => {
  const baseInput = {
    clientId: "1234567890.0987654321",
    scopes: ["chat:write", "channels:history", "im:history", "app_mentions:read"],
    redirectUri: "cognia://connector/oauth/slack",
    state: "random-csrf-state-abc123",
  }

  it("returns a URL starting with https://slack.com/oauth/v2/authorize", () => {
    const url = buildSlackOAuthUrl(baseInput)
    expect(url).toMatch(/^https:\/\/slack\.com\/oauth\/v2\/authorize\?/)
  })

  it("includes client_id in the URL", () => {
    const url = buildSlackOAuthUrl(baseInput)
    const parsed = new URL(url)
    expect(parsed.searchParams.get("client_id")).toBe("1234567890.0987654321")
  })

  it("joins scopes with comma", () => {
    const url = buildSlackOAuthUrl(baseInput)
    const parsed = new URL(url)
    expect(parsed.searchParams.get("scope")).toBe(
      "chat:write,channels:history,im:history,app_mentions:read"
    )
  })

  it("URL-encodes the redirect_uri", () => {
    const url = buildSlackOAuthUrl(baseInput)
    expect(url).toContain("redirect_uri=")
    const parsed = new URL(url)
    expect(parsed.searchParams.get("redirect_uri")).toBe("cognia://connector/oauth/slack")
  })

  it("includes state in the URL", () => {
    const url = buildSlackOAuthUrl(baseInput)
    const parsed = new URL(url)
    expect(parsed.searchParams.get("state")).toBe("random-csrf-state-abc123")
  })

  it("omits user_scope when userScopes is not provided", () => {
    const url = buildSlackOAuthUrl(baseInput)
    const parsed = new URL(url)
    expect(parsed.searchParams.has("user_scope")).toBe(false)
  })

  it("omits user_scope when userScopes is an empty array", () => {
    const url = buildSlackOAuthUrl({ ...baseInput, userScopes: [] })
    const parsed = new URL(url)
    expect(parsed.searchParams.has("user_scope")).toBe(false)
  })

  it("includes user_scope when userScopes is provided", () => {
    const url = buildSlackOAuthUrl({
      ...baseInput,
      userScopes: ["users:read", "users:read.email"],
    })
    const parsed = new URL(url)
    expect(parsed.searchParams.get("user_scope")).toBe("users:read,users:read.email")
  })

  it("matches a known-input vector exactly", () => {
    const url = buildSlackOAuthUrl({
      clientId: "111.222",
      scopes: ["chat:write"],
      redirectUri: "cognia://connector/oauth/slack",
      state: "state-xyz",
      userScopes: ["identity.basic"],
    })
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe("https://slack.com/oauth/v2/authorize")
    expect(parsed.searchParams.get("client_id")).toBe("111.222")
    expect(parsed.searchParams.get("scope")).toBe("chat:write")
    expect(parsed.searchParams.get("redirect_uri")).toBe("cognia://connector/oauth/slack")
    expect(parsed.searchParams.get("state")).toBe("state-xyz")
    expect(parsed.searchParams.get("user_scope")).toBe("identity.basic")
  })
})
