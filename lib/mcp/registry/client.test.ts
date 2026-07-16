import { registryEntryToPreset, searchRegistry, shortNameOf } from "./client"

// Shapes below mirror real /v0.1/servers payloads captured from
// registry.modelcontextprotocol.io.

describe("shortNameOf", () => {
  it("takes the trailing segment of a reverse-DNS name", () => {
    expect(shortNameOf("io.github.foo/bar")).toBe("bar")
    expect(shortNameOf("ac.inference.sh/mcp")).toBe("mcp")
  })

  it("passes through a name with no namespace", () => {
    expect(shortNameOf("filesystem")).toBe("filesystem")
  })

  it("sanitises characters that aren't valid in a server name", () => {
    expect(shortNameOf("x/we ird!name")).toBe("we-ird-name")
  })
})

describe("registryEntryToPreset — remotes", () => {
  it("prefers a remote over a package and marks it http", () => {
    const preset = registryEntryToPreset({
      server: {
        name: "ac.inference.sh/mcp",
        title: "inference.sh",
        description: "Run 150+ AI apps",
        remotes: [{ type: "streamable-http", url: "https://api.inference.sh/mcp" }],
        packages: [{ registryType: "npm", identifier: "should-be-ignored" }],
      },
    })
    expect(preset).toMatchObject({
      id: "mcp",
      name: "inference.sh",
      transport: "http",
      config: { url: "https://api.inference.sh/mcp" },
    })
  })

  it("maps an sse remote to the sse transport", () => {
    const preset = registryEntryToPreset({
      server: { name: "x/y", remotes: [{ type: "sse", url: "https://x/sse" }] },
    })
    expect(preset?.transport).toBe("sse")
  })

  it("offers an optional Authorization field for remotes", () => {
    const preset = registryEntryToPreset({
      server: { name: "x/y", remotes: [{ type: "streamable-http", url: "https://x" }] },
    })
    expect(preset?.fields).toEqual([
      expect.objectContaining({ key: "Authorization", secret: true }),
    ])
  })
})

describe("registryEntryToPreset — packages", () => {
  it("builds an npx command with runtime args before the package token", () => {
    const preset = registryEntryToPreset({
      server: {
        name: "com.pulsemcp/remote-filesystem",
        description: "Remote fs",
        version: "0.1.2",
        packages: [
          {
            registryType: "npm",
            identifier: "remote-filesystem-mcp-server",
            version: "0.1.2",
            runtimeHint: "npx",
            transport: { type: "stdio" },
            runtimeArguments: [{ value: "-y", type: "positional" }],
            environmentVariables: [
              { name: "GCS_BUCKET", isRequired: true, description: "Bucket" },
              { name: "GCS_PRIVATE_KEY", isSecret: true },
            ],
          },
        ],
      },
    })
    expect(preset).toMatchObject({
      id: "remote-filesystem",
      transport: "stdio",
      config: {
        command: "npx",
        args: ["-y", "remote-filesystem-mcp-server@0.1.2"],
        env: { GCS_BUCKET: "", GCS_PRIVATE_KEY: "" },
      },
    })
    expect(preset?.fields).toEqual([
      expect.objectContaining({ key: "GCS_BUCKET", placement: "env", secret: false }),
      expect.objectContaining({ key: "GCS_PRIVATE_KEY", secret: true }),
    ])
  })

  it("uses uvx for pypi packages and omits the version token", () => {
    const preset = registryEntryToPreset({
      server: {
        name: "x/timeserver",
        packages: [{ registryType: "pypi", identifier: "mcp-server-time", version: "1.2.3" }],
      },
    })
    expect(preset?.config).toEqual({ command: "uvx", args: ["mcp-server-time"] })
  })

  it("expands named package arguments into flag + value", () => {
    const preset = registryEntryToPreset({
      server: {
        name: "x/db",
        packages: [
          {
            registryType: "npm",
            identifier: "db-mcp",
            packageArguments: [{ type: "named", name: "--db-path", value: "/tmp/x.db" }],
          },
        ],
      },
    })
    expect(preset?.config.args).toEqual(["db-mcp", "--db-path", "/tmp/x.db"])
  })

  it("returns null for runtimes we cannot launch (oci / nuget)", () => {
    expect(
      registryEntryToPreset({
        server: { name: "x/y", packages: [{ registryType: "oci", identifier: "ghcr.io/x/y" }] },
      })
    ).toBeNull()
  })

  it("returns null when there is neither a remote nor a usable package", () => {
    expect(registryEntryToPreset({ server: { name: "x/y" } })).toBeNull()
  })

  it("returns null for a malformed entry", () => {
    expect(registryEntryToPreset({ server: { name: "" } })).toBeNull()
  })

  it("omits env from config when the package declares none", () => {
    const preset = registryEntryToPreset({
      server: { name: "x/y", packages: [{ registryType: "npm", identifier: "p" }] },
    })
    expect(preset?.config).toEqual({ command: "npx", args: ["p"] })
  })
})

describe("searchRegistry", () => {
  const fetchMock = jest.fn()
  const originalFetch = global.fetch

  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  function respond(body: unknown, ok = true, status = 200) {
    fetchMock.mockResolvedValue({ ok, status, json: async () => body })
  }

  it("sends search, limit and cursor to /v0.1/servers", async () => {
    respond({ servers: [], metadata: {} })
    await searchRegistry({ search: "github", cursor: "abc", limit: 5 })
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain("https://registry.modelcontextprotocol.io/v0.1/servers?")
    expect(url).toContain("search=github")
    expect(url).toContain("cursor=abc")
    expect(url).toContain("limit=5")
  })

  it("omits an empty search term", async () => {
    respond({ servers: [], metadata: {} })
    await searchRegistry({ search: "   " })
    expect(fetchMock.mock.calls[0][0]).not.toContain("search=")
  })

  it("maps entries and returns the next cursor", async () => {
    respond({
      servers: [
        { server: { name: "a/one", remotes: [{ type: "streamable-http", url: "https://one" }] } },
      ],
      metadata: { nextCursor: "next-1" },
    })
    const result = await searchRegistry({})
    expect(result.presets).toHaveLength(1)
    expect(result.presets[0].id).toBe("one")
    expect(result.nextCursor).toBe("next-1")
  })

  it("drops unrepresentable entries instead of failing the page", async () => {
    respond({
      servers: [
        { server: { name: "a/ok", remotes: [{ type: "streamable-http", url: "https://ok" }] } },
        { server: { name: "a/bad", packages: [{ registryType: "oci", identifier: "z" }] } },
      ],
      metadata: {},
    })
    const result = await searchRegistry({})
    expect(result.presets.map((p) => p.id)).toEqual(["ok"])
    expect(result.nextCursor).toBeNull()
  })

  it("de-dupes repeated versions of the same server, keeping the first", async () => {
    respond({
      servers: [
        {
          server: {
            name: "a/dup",
            version: "1.0.0",
            remotes: [{ type: "streamable-http", url: "https://v1" }],
          },
        },
        {
          server: {
            name: "a/dup",
            version: "1.0.1",
            remotes: [{ type: "streamable-http", url: "https://v2" }],
          },
        },
      ],
      metadata: {},
    })
    const result = await searchRegistry({})
    expect(result.presets).toHaveLength(1)
    expect(result.presets[0].config.url).toBe("https://v1")
  })

  it("keeps two distinct servers whose short names collide", async () => {
    respond({
      servers: [
        {
          server: {
            name: "com.a/github",
            remotes: [{ type: "streamable-http", url: "https://a" }],
          },
        },
        {
          server: {
            name: "com.b/github",
            remotes: [{ type: "streamable-http", url: "https://b" }],
          },
        },
      ],
      metadata: {},
    })
    const result = await searchRegistry({})
    // Both must survive — they are different servers, not two versions of one.
    expect(result.presets).toHaveLength(2)
    expect(result.presets.map((p) => p.id)).toEqual(["github", "github-2"])
  })

  it("throws with the status on a non-ok response", async () => {
    respond({}, false, 503)
    await expect(searchRegistry({})).rejects.toThrow("503")
  })

  it("tolerates a payload with no servers array", async () => {
    respond({})
    const result = await searchRegistry({})
    expect(result).toEqual({ presets: [], nextCursor: null })
  })
})
