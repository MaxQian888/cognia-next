import { deriveId, resolveIdentity, slugify, titleize } from "./identity"

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("My Cool Server")).toBe("my-cool-server")
    expect(slugify("@modelcontextprotocol/server-filesystem")).toBe(
      "modelcontextprotocol-server-filesystem"
    )
  })

  it("collapses runs and trims edges", () => {
    expect(slugify("--a___b--")).toBe("a-b")
  })

  it("returns an empty string for input with no alphanumerics", () => {
    expect(slugify("///")).toBe("")
  })
})

describe("deriveId", () => {
  it("appends the source suffix", () => {
    expect(deriveId("playwright", "mcp")).toBe("playwright-mcp")
  })

  it("does not double the suffix", () => {
    expect(deriveId("playwright-mcp", "mcp")).toBe("playwright-mcp")
    expect(deriveId("mcp", "mcp")).toBe("mcp")
  })

  it("throws when nothing slug-able remains", () => {
    expect(() => deriveId("///", "mcp")).toThrow(/cannot derive a plugin id/)
  })
})

describe("titleize", () => {
  it("title-cases a slug", () => {
    expect(titleize("github-delivery")).toBe("Github Delivery")
  })
})

describe("resolveIdentity", () => {
  const defaults = {
    stem: "playwright",
    name: "Playwright",
    description: "Browser automation.",
    suffix: "mcp",
    hostVersion: "1.4.0",
  }

  it("derives every field with no overrides", () => {
    expect(resolveIdentity(defaults)).toEqual({
      id: "playwright-mcp",
      name: "Playwright",
      description: "Browser automation.",
      version: "0.1.0",
      author: "unknown",
      authorEmail: undefined,
      license: "MIT",
      minAppVersion: "1.4.0",
    })
  })

  it("prefers the git author when one was read", () => {
    expect(resolveIdentity({ ...defaults, author: "Ada" }).author).toBe("Ada")
  })

  it("lets overrides win", () => {
    const resolved = resolveIdentity(defaults, {
      id: "custom.id",
      name: "Custom",
      version: "2.0.0",
      author: "Ada",
      authorEmail: "ada@example.com",
      license: "Apache-2.0",
      minAppVersion: "0.9.0",
    })
    expect(resolved).toEqual({
      id: "custom.id",
      name: "Custom",
      description: "Browser automation.",
      version: "2.0.0",
      author: "Ada",
      authorEmail: "ada@example.com",
      license: "Apache-2.0",
      minAppVersion: "0.9.0",
    })
  })

  it("treats blank overrides as absent", () => {
    expect(resolveIdentity(defaults, { author: "   ", name: "" })).toMatchObject({
      author: "unknown",
      name: "Playwright",
    })
  })

  it("falls back to a titleized stem when the source has no display name", () => {
    expect(resolveIdentity({ ...defaults, name: "" }).name).toBe("Playwright")
  })

  it("rejects an override id the host manifest schema would refuse", () => {
    expect(() => resolveIdentity(defaults, { id: "-bad id" })).toThrow(/invalid/)
  })

  it("never produces a publicKey or signing material", () => {
    expect(Object.keys(resolveIdentity(defaults))).not.toContain("publicKey")
  })
})
