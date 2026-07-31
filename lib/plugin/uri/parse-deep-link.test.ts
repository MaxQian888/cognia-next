import { parseDeepLink } from "./parse-deep-link"

describe("parseDeepLink", () => {
  it("parses pluginId, path and query", () => {
    const p = parseDeepLink("cognia://plugin/acme.todo/auth/callback?code=abc&state=xyz")
    expect(p).toMatchObject({
      pluginId: "acme.todo",
      path: "auth/callback",
      query: { code: "abc", state: "xyz" },
    })
  })

  it("parses a plugin id with no extra path", () => {
    const p = parseDeepLink("cognia://plugin/acme")
    expect(p).toMatchObject({ pluginId: "acme", path: "", query: {} })
  })

  it("strips a trailing slash on the path", () => {
    expect(parseDeepLink("cognia://plugin/acme/open/")?.path).toBe("open")
  })

  it("decodes a percent-encoded plugin id", () => {
    expect(parseDeepLink("cognia://plugin/acme%2Etodo/x")?.pluginId).toBe("acme.todo")
  })

  it("returns null for a non-plugin host", () => {
    expect(parseDeepLink("cognia://connector/oauth/lark?code=1")).toBeNull()
  })

  it("returns null for the wrong scheme", () => {
    expect(parseDeepLink("https://plugin/acme")).toBeNull()
  })

  it("returns null when the plugin id is missing", () => {
    expect(parseDeepLink("cognia://plugin/")).toBeNull()
    expect(parseDeepLink("cognia://plugin")).toBeNull()
  })

  it("preserves the raw url", () => {
    const raw = "cognia://plugin/acme/x?y=1"
    expect(parseDeepLink(raw)?.raw).toBe(raw)
  })
})
