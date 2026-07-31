import { humanizeKey, isAbsolutePathArg, looksSecret, sanitizeMcpConfig } from "./secrets"

describe("looksSecret", () => {
  it.each([
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
    "BRAVE_API_KEY",
    "DB_PASSWORD",
    "Authorization",
    "SENTRY_DSN",
    "SLACK_WEBHOOK_URL",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "SESSION_ID",
  ])("flags %s", (key) => {
    expect(looksSecret(key)).toBe(true)
  })

  it.each(["NODE_ENV", "LOG_LEVEL", "GITLAB_API_URL", "TZ"])("does not flag %s", (key) => {
    expect(looksSecret(key)).toBe(false)
  })
})

describe("humanizeKey", () => {
  it("turns SCREAMING_SNAKE into a sentence", () => {
    expect(humanizeKey("GITLAB_PERSONAL_ACCESS_TOKEN")).toBe("Gitlab personal access token")
  })

  it("splits camelCase", () => {
    expect(humanizeKey("apiKey")).toBe("Api key")
  })
})

describe("isAbsolutePathArg", () => {
  it.each(["/Users/me/docs", "~/notes", "C:/data", "d:\\data"])("flags %s", (value) => {
    expect(isAbsolutePathArg(value)).toBe(true)
  })

  it.each(["-y", "@playwright/mcp@latest", "--headless", "./rel", "/"])(
    "does not flag %s",
    (value) => {
      expect(isAbsolutePathArg(value)).toBe(false)
    }
  )
})

describe("sanitizeMcpConfig", () => {
  it("blanks every env value and declares a field for each", () => {
    const { config, fields, todos } = sanitizeMcpConfig("stdio", {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "ghp_realsecret", LOG_LEVEL: "debug" },
    })

    expect(config.env).toEqual({ GITHUB_TOKEN: "", LOG_LEVEL: "" })
    expect(JSON.stringify(config)).not.toContain("ghp_realsecret")
    expect(JSON.stringify(config)).not.toContain("debug")
    expect(fields).toEqual([
      { key: "GITHUB_TOKEN", label: "Github token", placement: "env", secret: true },
      { key: "LOG_LEVEL", label: "Log level", placement: "env" },
    ])
    expect(todos).toHaveLength(2)
  })

  it("keeps command and non-path args verbatim", () => {
    const { config } = sanitizeMcpConfig("stdio", {
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--headless"],
    })
    expect(config).toEqual({
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--headless"],
    })
  })

  it("tokenizes absolute path arguments into arg-replace fields", () => {
    const { config, fields } = sanitizeMcpConfig("stdio", {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"],
    })
    expect(config.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "<DOCUMENTS>"])
    expect(fields).toEqual([
      expect.objectContaining({
        key: "DOCUMENTS",
        placement: "arg-replace",
        token: "<DOCUMENTS>",
      }),
    ])
    expect(JSON.stringify(config)).not.toContain("/Users/me")
  })

  it("disambiguates repeated path tokens", () => {
    const { fields } = sanitizeMcpConfig("stdio", {
      command: "srv",
      args: ["/a/data", "/b/data"],
    })
    expect(fields.map((f) => f.key)).toEqual(["DATA", "DATA_2"])
  })

  it("drops headers entirely and declares them as secret fields", () => {
    const { config, fields } = sanitizeMcpConfig("http", {
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer live-token" },
    })
    expect(config).toEqual({ url: "https://mcp.example.com/mcp" })
    expect(fields).toEqual([
      { key: "Authorization", label: "Authorization", placement: "header", secret: true },
    ])
  })

  it("keeps a plain remote URL — it identifies the server, not the user", () => {
    const { config, fields } = sanitizeMcpConfig("http", { url: "https://mcp.deepwiki.com/mcp" })
    expect(config.url).toBe("https://mcp.deepwiki.com/mcp")
    expect(fields).toEqual([])
  })

  it.each([
    "https://mcp.example.com/mcp?api_key=live",
    "https://user:pw@mcp.example.com/mcp",
    "https://mcp.example.com/mcp?access_token=abc",
  ])("replaces a credential-bearing URL (%s) with a url field", (url) => {
    const { config, fields } = sanitizeMcpConfig("sse", { url })
    expect(config.url).toBeUndefined()
    expect(fields).toEqual([expect.objectContaining({ key: "url", placement: "url" })])
    expect(JSON.stringify(config)).not.toContain("live")
  })

  it("treats an unparseable URL as user-specific", () => {
    const { config } = sanitizeMcpConfig("http", { url: "not a url" })
    expect(config.url).toBeUndefined()
  })

  it("does not mutate the caller's config", () => {
    const original = { command: "npx", env: { A: "1" } }
    sanitizeMcpConfig("stdio", original)
    expect(original.env).toEqual({ A: "1" })
  })
})
