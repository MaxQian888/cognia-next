import {
  buildMcpInstallCommand,
  buildMcpTransferJson,
  guessServerName,
  parseMcpConfigJson,
  parseMcpInstallCommand,
  parseMcpTransferInput,
  sanitizeMcpName,
  shellQuote,
  tokenizeShellCommand,
} from "./config-transfer"

describe("tokenizeShellCommand", () => {
  it("keeps single-quoted runs literal", () => {
    expect(tokenizeShellCommand(`a 'b c' d`)).toEqual(["a", "b c", "d"])
  })

  it("honours escapes inside double quotes", () => {
    expect(tokenizeShellCommand(`x "a \\"b\\" c"`)).toEqual(["x", 'a "b" c'])
  })

  it("joins backslash-newline continuations", () => {
    expect(tokenizeShellCommand("claude mcp add \\\n  foo")).toEqual([
      "claude",
      "mcp",
      "add",
      "foo",
    ])
  })

  it("preserves an empty quoted token", () => {
    expect(tokenizeShellCommand(`a "" b`)).toEqual(["a", "", "b"])
  })

  it("returns null for an unclosed quote", () => {
    expect(tokenizeShellCommand(`a "b`)).toBeNull()
  })
})

describe("sanitizeMcpName / guessServerName", () => {
  it("strips characters the namespace validator rejects", () => {
    expect(sanitizeMcpName("@scope/My Server!")).toBe("scope-My-Server")
  })

  it("prefers the package spec over the runner", () => {
    expect(guessServerName("npx", ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"])).toBe(
      "server-filesystem"
    )
  })

  it("falls back to the binary when nothing looks like a package", () => {
    expect(guessServerName("/usr/local/bin/my-tool", ["--port", "3000"])).toBe("my-tool")
  })
})

describe("parseMcpInstallCommand — claude code", () => {
  it("parses the documented stdio form with a separator", () => {
    const result = parseMcpInstallCommand(
      "claude mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /tmp"
    )
    expect(result.error).toBeUndefined()
    expect(result.drafts).toEqual([
      {
        name: "filesystem",
        transport: "stdio",
        config: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
        },
      },
    ])
  })

  it("parses the separator-less form", () => {
    expect(parseMcpInstallCommand("claude mcp add git uvx mcp-server-git").drafts).toEqual([
      { name: "git", transport: "stdio", config: { command: "uvx", args: ["mcp-server-git"] } },
    ])
  })

  it("collects repeated --env flags", () => {
    const result = parseMcpInstallCommand(
      `claude mcp add gh -e GITHUB_TOKEN=abc --env HOST=example.com -- npx -y server-github`
    )
    expect(result.drafts[0].config).toMatchObject({
      env: { GITHUB_TOKEN: "abc", HOST: "example.com" },
    })
  })

  it("parses a remote server with headers", () => {
    const result = parseMcpInstallCommand(
      `claude mcp add --transport http linear https://mcp.linear.app/mcp --header "Authorization: Bearer xyz"`
    )
    expect(result.drafts).toEqual([
      {
        name: "linear",
        transport: "http",
        config: {
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer xyz" },
        },
      },
    ])
  })

  it("drops --scope without swallowing the name", () => {
    const result = parseMcpInstallCommand("claude mcp add --scope user notes -- node server.js")
    expect(result.drafts[0].name).toBe("notes")
    expect(result.warnings).toContainEqual({ code: "ignored-flag", flag: "--scope" })
  })

  it("parses the add-json form", () => {
    const result = parseMcpInstallCommand(
      `claude mcp add-json weather '{"command":"node","args":["w.js"]}'`
    )
    expect(result.kind).toBe("command")
    expect(result.drafts).toEqual([
      { name: "weather", transport: "stdio", config: { command: "node", args: ["w.js"] } },
    ])
  })
})

describe("parseMcpInstallCommand — other agents", () => {
  it("parses codex's separator form", () => {
    expect(
      parseMcpInstallCommand("codex mcp add docs --env KEY=v -- uvx mcp-server-docs").drafts
    ).toEqual([
      {
        name: "docs",
        transport: "stdio",
        config: { command: "uvx", args: ["mcp-server-docs"], env: { KEY: "v" } },
      },
    ])
  })

  it("parses gemini's -t sse form", () => {
    expect(parseMcpInstallCommand("gemini mcp add -t sse feed https://x.dev/sse").drafts).toEqual([
      { name: "feed", transport: "sse", config: { url: "https://x.dev/sse" } },
    ])
  })

  it("parses the VS Code --add-mcp payload", () => {
    expect(
      parseMcpInstallCommand(`code --add-mcp '{"name":"pg","command":"npx","args":["pg-mcp"]}'`)
        .drafts
    ).toEqual([{ name: "pg", transport: "stdio", config: { command: "npx", args: ["pg-mcp"] } }])
  })
})

describe("parseMcpInstallCommand — bare command lines", () => {
  it("treats a plain runner line as an stdio server and guesses the name", () => {
    const result = parseMcpInstallCommand("npx -y @modelcontextprotocol/server-memory")
    expect(result.drafts).toEqual([
      {
        name: "server-memory",
        transport: "stdio",
        config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
      },
    ])
    expect(result.warnings).toContainEqual({ code: "guessed-name", name: "server-memory" })
  })

  it("lifts a KEY=value prefix into env", () => {
    expect(parseMcpInstallCommand("API_KEY=secret npx -y weather-mcp").drafts[0].config).toEqual({
      command: "npx",
      args: ["-y", "weather-mcp"],
      env: { API_KEY: "secret" },
    })
  })

  it("strips a copied shell prompt and code fence", () => {
    expect(parseMcpInstallCommand("```bash\n$ uvx mcp-server-time\n```").drafts[0].config).toEqual({
      command: "uvx",
      args: ["mcp-server-time"],
    })
  })

  it("treats a bare URL as an http server", () => {
    expect(parseMcpInstallCommand("https://mcp.example.com/mcp").drafts).toEqual([
      {
        name: "mcp.example.com",
        transport: "http",
        config: { url: "https://mcp.example.com/mcp" },
      },
    ])
  })

  it("reports empty input", () => {
    expect(parseMcpInstallCommand("   ")).toMatchObject({ kind: "empty", error: "empty" })
  })
})

describe("parseMcpConfigJson", () => {
  it("parses the canonical mcpServers block", () => {
    const result = parseMcpConfigJson(
      JSON.stringify({
        mcpServers: {
          fs: { command: "npx", args: ["-y", "server-filesystem"] },
          api: { type: "http", url: "https://api.example.com/mcp" },
        },
      })
    )
    expect(result.drafts).toEqual([
      {
        name: "fs",
        transport: "stdio",
        config: { command: "npx", args: ["-y", "server-filesystem"] },
      },
      { name: "api", transport: "http", config: { url: "https://api.example.com/mcp" } },
    ])
  })

  it("accepts VS Code's `servers` key", () => {
    expect(
      parseMcpConfigJson(JSON.stringify({ servers: { x: { command: "node" } } })).drafts
    ).toEqual([{ name: "x", transport: "stdio", config: { command: "node" } }])
  })

  it("accepts codex's mcp_servers key", () => {
    expect(
      parseMcpConfigJson(JSON.stringify({ mcp_servers: { y: { command: "uvx" } } })).drafts
    ).toEqual([{ name: "y", transport: "stdio", config: { command: "uvx" } }])
  })

  it("accepts a single entry object and takes the name from the caller", () => {
    expect(parseMcpConfigJson(`{"command":"node","args":["a.js"]}`, "solo").drafts).toEqual([
      { name: "solo", transport: "stdio", config: { command: "node", args: ["a.js"] } },
    ])
  })

  it("guesses a name for an unnamed single entry", () => {
    const result = parseMcpConfigJson(`{"command":"npx","args":["-y","weather-mcp"]}`)
    expect(result.drafts[0].name).toBe("weather-mcp")
    expect(result.warnings).toContainEqual({ code: "guessed-name", name: "weather-mcp" })
  })

  it("sanitizes a name the namespace validator would reject", () => {
    const result = parseMcpConfigJson(
      JSON.stringify({ mcpServers: { "my server": { command: "x" } } })
    )
    expect(result.drafts[0].name).toBe("my-server")
    expect(result.warnings).toContainEqual({ code: "renamed", from: "my server", to: "my-server" })
  })

  it("skips an entry with neither command nor url", () => {
    const result = parseMcpConfigJson(JSON.stringify({ mcpServers: { broken: { foo: 1 } } }))
    expect(result.drafts).toEqual([])
    expect(result.warnings).toContainEqual({ code: "skipped-entry", name: "broken" })
  })

  it("reports invalid JSON", () => {
    expect(parseMcpConfigJson("{oops")).toMatchObject({ kind: "json", error: "invalid-json" })
  })
})

describe("parseMcpTransferInput", () => {
  it("routes a brace-leading paste to the JSON parser", () => {
    expect(parseMcpTransferInput(`{"mcpServers":{"a":{"command":"x"}}}`).kind).toBe("json")
  })

  it("routes anything else to the command parser", () => {
    expect(parseMcpTransferInput("claude mcp add a -- x").kind).toBe("command")
  })
})

describe("shellQuote", () => {
  it("leaves safe tokens bare and quotes the rest", () => {
    expect(shellQuote("npx")).toBe("npx")
    expect(shellQuote("a b")).toBe("'a b'")
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(shellQuote("")).toBe("''")
  })
})

describe("buildMcpInstallCommand", () => {
  const stdio = {
    name: "filesystem",
    transport: "stdio" as const,
    config: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
  }

  it("round-trips a claude-code stdio server", () => {
    const command = buildMcpInstallCommand(stdio, "claude-code")
    expect(command).toBe(
      "claude mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /tmp"
    )
    expect(parseMcpInstallCommand(command).drafts).toEqual([stdio])
  })

  it("round-trips a remote server with headers", () => {
    const remote = {
      name: "linear",
      transport: "http" as const,
      config: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer xyz" } },
    }
    const command = buildMcpInstallCommand(remote, "claude-code")
    expect(parseMcpInstallCommand(command).drafts).toEqual([remote])
  })

  it("omits --transport for a CLI that has no such flag", () => {
    expect(buildMcpInstallCommand(stdio, "codex")).toBe(
      "codex mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /tmp"
    )
  })

  it("emits a bare shell line for an agent with no CLI grammar", () => {
    expect(buildMcpInstallCommand(stdio, "cursor")).toBe(
      "npx -y @modelcontextprotocol/server-filesystem /tmp"
    )
  })

  it("never renders a secret value, only its locator", () => {
    expect(
      buildMcpInstallCommand(
        {
          name: "gh",
          transport: "stdio",
          config: { command: "node", env: { TOKEN: { secretRef: "mcp/gh/TOKEN" } } },
        },
        "claude-code"
      )
    ).toContain("${mcp/gh/TOKEN}")
  })
})

describe("buildMcpTransferJson", () => {
  const servers = [
    { name: "b", transport: "stdio" as const, config: { command: "node" } },
    { name: "a", transport: "http" as const, config: { url: "https://x.dev/mcp" } },
  ]

  it("emits a name-sorted canonical block", () => {
    const parsed = JSON.parse(buildMcpTransferJson(servers))
    expect(Object.keys(parsed.mcpServers)).toEqual(["a", "b"])
    expect(parsed.mcpServers.a).toEqual({ type: "http", url: "https://x.dev/mcp" })
  })

  it("round-trips through the JSON parser", () => {
    expect(parseMcpConfigJson(buildMcpTransferJson(servers)).drafts).toHaveLength(2)
  })

  it("delegates to the agent adapter's own projection", () => {
    const parsed = JSON.parse(buildMcpTransferJson(servers, "codex"))
    // Codex writes `mcp_servers` and drops the `type` discriminator.
    expect(parsed.mcp_servers.b).toEqual({ command: "node" })
  })
})
