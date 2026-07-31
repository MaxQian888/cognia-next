import {
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_OAUTH_TOKEN_URL,
  OAUTH_ENDPOINTS,
  OAUTH_REQUEST_HEADERS,
  OAUTH_REQUIRED_BETA_FEATURES,
} from "./constants"

describe("Anthropic OAuth constants", () => {
  it("keeps subscription and console authorization endpoints distinct", () => {
    expect(CLAUDE_OAUTH_CLIENT_ID).toMatch(/^[0-9a-f-]{36}$/)
    expect(CLAUDE_OAUTH_TOKEN_URL).toBe("https://platform.claude.com/v1/oauth/token")
    expect(OAUTH_ENDPOINTS.subscription.authorizeUrl).toBe("https://claude.ai/oauth/authorize")
    expect(OAUTH_ENDPOINTS.console.authorizeUrl).toBe(
      "https://console.anthropic.com/oauth/authorize"
    )
    expect(OAUTH_ENDPOINTS.subscription.redirectUri).not.toBe(OAUTH_ENDPOINTS.console.redirectUri)
  })

  it("builds the required OAuth headers without impersonating a CLI user agent", () => {
    expect(OAUTH_REQUIRED_BETA_FEATURES).toContain("oauth-2025-04-20")
    expect(OAUTH_REQUEST_HEADERS).toEqual({
      "anthropic-version": "2023-06-01",
      "anthropic-beta": OAUTH_REQUIRED_BETA_FEATURES.join(","),
      "x-app": "cli",
    })
    expect(OAUTH_REQUEST_HEADERS).not.toHaveProperty("User-Agent")
  })
})
