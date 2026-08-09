import { applyPresetFields, getPreset, MCP_PRESETS } from "./mcp-presets"

describe("MCP_PRESETS catalog", () => {
  it("has unique IDs", () => {
    const ids = MCP_PRESETS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("has at least the canonical filesystem and github presets", () => {
    expect(getPreset("filesystem")).toBeDefined()
    expect(getPreset("github")).toBeDefined()
  })

  it("registers the existing-browser Playwright extension preset with its safety default", () => {
    expect(getPreset("playwright-existing-browser")).toMatchObject({
      transport: "stdio",
      config: {
        command: "npx",
        args: ["-y", "@playwright/mcp@latest", "--extension"],
      },
      defaultDisallowedTools: ["browser_run_code_unsafe"],
    })
  })

  it("each field with placement=arg-replace declares a token", () => {
    for (const preset of MCP_PRESETS) {
      for (const field of preset.fields) {
        if (field.placement === "arg-replace") {
          expect(field.token).toBeTruthy()
        }
      }
    }
  })

  // These npm packages are all marked "Package no longer supported" on the
  // registry — installing one hands the user a server that can't start.
  // Every entry here was verified deprecated against registry.npmjs.org.
  it("references no deprecated @modelcontextprotocol packages", () => {
    const DEPRECATED = [
      "@modelcontextprotocol/server-github",
      "@modelcontextprotocol/server-gitlab",
      "@modelcontextprotocol/server-brave-search",
      "@modelcontextprotocol/server-postgres",
      "@modelcontextprotocol/server-puppeteer",
      "@modelcontextprotocol/server-slack",
    ]
    for (const preset of MCP_PRESETS) {
      const args = (preset.config.args as unknown[] | undefined) ?? []
      for (const arg of args) {
        if (typeof arg !== "string") continue
        for (const pkg of DEPRECATED) {
          expect(arg.startsWith(pkg)).toBe(false)
        }
      }
    }
  })
})

describe("applyPresetFields", () => {
  it("substitutes arg-replace tokens", () => {
    const fs = getPreset("filesystem")!
    const config = applyPresetFields(fs, { PATH: "/Users/me/work" })
    expect(config.command).toBe("npx")
    expect(config.args as string[]).toContain("/Users/me/work")
    expect(config.args as string[]).not.toContain("<PATH>")
  })

  it("fills env vars", () => {
    const gl = getPreset("gitlab")!
    const config = applyPresetFields(gl, {
      GITLAB_PERSONAL_ACCESS_TOKEN: "glpat_abc",
    })
    expect((config.env as Record<string, string>).GITLAB_PERSONAL_ACCESS_TOKEN).toBe("glpat_abc")
  })

  it("does not mutate the preset", () => {
    const fs = getPreset("filesystem")!
    const before = JSON.stringify(fs.config)
    applyPresetFields(fs, { PATH: "/x" })
    expect(JSON.stringify(fs.config)).toBe(before)
  })

  it("uses empty string when a value is missing", () => {
    const fs = getPreset("filesystem")!
    const config = applyPresetFields(fs, {})
    expect(config.args as string[]).toContain("")
  })
})

describe("HTTP / SSE presets", () => {
  it("ships DeepWiki + http-generic + sse-generic", () => {
    const dw = getPreset("deepwiki")
    expect(dw?.transport).toBe("http")
    expect(dw?.config.url).toMatch(/^https:\/\/mcp\.deepwiki\.com/)

    const httpGeneric = getPreset("http-generic")
    expect(httpGeneric?.transport).toBe("http")
    expect(httpGeneric?.fields.find((f) => f.placement === "url")).toBeDefined()
    expect(httpGeneric?.fields.find((f) => f.placement === "header")).toBeDefined()

    const sseGeneric = getPreset("sse-generic")
    expect(sseGeneric?.transport).toBe("sse")
  })

  it("applyPresetFields writes url + header values", () => {
    const httpGeneric = getPreset("http-generic")!
    const config = applyPresetFields(httpGeneric, {
      url: "https://example.com/mcp",
      Authorization: "Bearer abc",
    })
    expect(config.url).toBe("https://example.com/mcp")
    expect((config.headers as Record<string, string>).Authorization).toBe("Bearer abc")
  })

  it("applyPresetFields drops empty header values + empty headers map", () => {
    const httpGeneric = getPreset("http-generic")!
    const config = applyPresetFields(httpGeneric, {
      url: "https://example.com/mcp",
      Authorization: "",
    })
    expect(config.url).toBe("https://example.com/mcp")
    expect(config.headers).toBeUndefined()
  })

  it("preserves non-empty user headers when other field is blank", () => {
    const httpGeneric = getPreset("http-generic")!
    const config = applyPresetFields(httpGeneric, {
      url: "",
      Authorization: "Bearer abc",
    })
    expect(config.url).toBe("")
    expect((config.headers as Record<string, string>).Authorization).toBe("Bearer abc")
  })
})
