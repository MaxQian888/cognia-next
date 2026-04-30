import type { McpImportDraft } from "@/lib/db/mcp-servers"

import { denormalizeMcpEntry, dropInvalidDrafts, normalizeMcpEntry } from "./shared"

describe("normalizeMcpEntry", () => {
  it("returns null for null / non-object input", () => {
    expect(normalizeMcpEntry(null)).toBeNull()
    expect(normalizeMcpEntry(undefined)).toBeNull()
    expect(normalizeMcpEntry("not-object")).toBeNull()
    expect(normalizeMcpEntry(42)).toBeNull()
  })

  it("returns null when no transport hint can be derived", () => {
    expect(normalizeMcpEntry({ random: "thing" })).toBeNull()
  })

  it("honours an explicit type=stdio discriminator and strips it", () => {
    const out = normalizeMcpEntry({ type: "stdio", command: "npx" })
    expect(out).toEqual({ transport: "stdio", config: { command: "npx" } })
  })

  it("honours type=sse and type=http", () => {
    expect(normalizeMcpEntry({ type: "sse", url: "https://x/sse" })).toEqual({
      transport: "sse",
      config: { url: "https://x/sse" },
    })
    expect(normalizeMcpEntry({ type: "http", url: "https://x/http" })).toEqual({
      transport: "http",
      config: { url: "https://x/http" },
    })
  })

  it("honours the legacy `transport` discriminator instead of `type`", () => {
    const out = normalizeMcpEntry({ transport: "stdio", command: "npx" })
    expect(out).toEqual({ transport: "stdio", config: { command: "npx" } })
    // ensures the discriminator key is stripped from the output.
    expect(out?.config).not.toHaveProperty("transport")
  })

  it("collapses streamable-http (Roo Code spelling) into http", () => {
    const out = normalizeMcpEntry({ type: "streamable-http", url: "https://x/mcp" })
    expect(out).toEqual({ transport: "http", config: { url: "https://x/mcp" } })
  })

  it("Gemini quirk: httpUrl gets renamed to url and forced to http", () => {
    const out = normalizeMcpEntry({ httpUrl: "https://x/http" })
    expect(out).toEqual({ transport: "http", config: { url: "https://x/http" } })
  })

  it("infers http when only url is present", () => {
    const out = normalizeMcpEntry({ url: "https://x/api" })
    expect(out).toEqual({ transport: "http", config: { url: "https://x/api" } })
  })

  it("supports a custom URL key (windsurf serverUrl) and renames it to url", () => {
    const out = normalizeMcpEntry(
      { serverUrl: "https://your/mcp", headers: { K: "v" } },
      { urlKey: "serverUrl" }
    )
    expect(out).toEqual({
      transport: "http",
      config: { url: "https://your/mcp", headers: { K: "v" } },
    })
  })

  it("does not rename when the url key is the canonical 'url'", () => {
    const out = normalizeMcpEntry({ url: "https://e/x" }, { urlKey: "url" })
    expect(out?.config).toEqual({ url: "https://e/x" })
  })

  it("infers stdio when only command is present", () => {
    const out = normalizeMcpEntry({ command: "npx", args: ["-y", "fs"] })
    expect(out).toEqual({
      transport: "stdio",
      config: { command: "npx", args: ["-y", "fs"] },
    })
  })

  it("forceTransport overrides whatever the entry has", () => {
    const out = normalizeMcpEntry(
      { type: "http", url: "https://x", command: "should-be-ignored" },
      { forceTransport: "stdio" }
    )
    expect(out?.transport).toBe("stdio")
    // both type and url stay or are stripped per the regular rules — type is
    // always stripped because it's a discriminator.
    expect(out?.config).not.toHaveProperty("type")
  })

  it("returns null when force overrides aren't set and the shape is unknown", () => {
    expect(normalizeMcpEntry({})).toBeNull()
  })
})

describe("denormalizeMcpEntry", () => {
  it("emits type='stdio' by default for stdio servers", () => {
    expect(denormalizeMcpEntry("stdio", { command: "npx" })).toEqual({
      type: "stdio",
      command: "npx",
    })
  })

  it("omits the type key when typeKey is null (claude-desktop)", () => {
    expect(denormalizeMcpEntry("stdio", { command: "npx" }, { typeKey: null })).toEqual({
      command: "npx",
    })
  })

  it("emits the transport name as type for sse / http", () => {
    expect(denormalizeMcpEntry("sse", { url: "https://x" })).toEqual({
      type: "sse",
      url: "https://x",
    })
    expect(denormalizeMcpEntry("http", { url: "https://x" })).toEqual({
      type: "http",
      url: "https://x",
    })
  })

  it("renames url → custom urlKey on remote writes (windsurf serverUrl)", () => {
    const out = denormalizeMcpEntry(
      "http",
      { url: "https://your/mcp" },
      { typeKey: null, urlKey: "serverUrl" }
    )
    expect(out).toEqual({ serverUrl: "https://your/mcp" })
  })

  it("keeps url under canonical 'url' when urlKey is omitted", () => {
    const out = denormalizeMcpEntry("http", { url: "https://x" }, { typeKey: "type" })
    expect(out).toEqual({ type: "http", url: "https://x" })
  })

  it("does not rename when the config has no url field", () => {
    const out = denormalizeMcpEntry("http", { command: "x" }, { urlKey: "serverUrl" })
    expect(out).toEqual({ type: "http", command: "x" })
  })

  it("Gemini split: http servers use httpUrl, sse stays under url, stdio untouched", () => {
    const httpOut = denormalizeMcpEntry("http", { url: "https://x" }, { geminiUrlSplit: true })
    expect(httpOut).toEqual({ httpUrl: "https://x" })

    const sseOut = denormalizeMcpEntry("sse", { url: "https://sse" }, { geminiUrlSplit: true })
    expect(sseOut).toEqual({ url: "https://sse" })

    const stdioOut = denormalizeMcpEntry(
      "stdio",
      { command: "npx" },
      { geminiUrlSplit: true, typeKey: null }
    )
    expect(stdioOut).toEqual({ command: "npx" })
  })

  it("Gemini split is a no-op when the http config has no url", () => {
    const out = denormalizeMcpEntry("http", { foo: "bar" }, { geminiUrlSplit: true })
    expect(out).toEqual({ foo: "bar" })
    expect(out).not.toHaveProperty("url")
    expect(out).not.toHaveProperty("httpUrl")
  })

  it("preserves arbitrary opaque keys (headers, env, etc.)", () => {
    const out = denormalizeMcpEntry("http", {
      url: "https://x",
      headers: { Authorization: "Bearer t" },
      timeout: 5,
    })
    expect(out).toMatchObject({
      type: "http",
      url: "https://x",
      headers: { Authorization: "Bearer t" },
      timeout: 5,
    })
  })
})

describe("dropInvalidDrafts", () => {
  function draft(p: Partial<McpImportDraft>): McpImportDraft {
    return {
      name: p.name ?? "x",
      transport: p.transport ?? "stdio",
      config: p.config ?? {},
    }
  }

  it("drops entries with empty / whitespace names", () => {
    const out = dropInvalidDrafts([
      draft({ name: "", config: { command: "x" } }),
      draft({ name: "   ", config: { command: "x" } }),
      draft({ name: "ok", config: { command: "x" } }),
    ])
    expect(out.map((d) => d.name)).toEqual(["ok"])
  })

  it("drops entries whose name is undefined", () => {
    const bogus = { transport: "stdio", config: { command: "x" } } as unknown as McpImportDraft
    const out = dropInvalidDrafts([bogus, draft({ name: "ok", config: { command: "x" } })])
    expect(out.map((d) => d.name)).toEqual(["ok"])
  })

  it("drops stdio drafts that are missing a command", () => {
    const out = dropInvalidDrafts([
      draft({ name: "no-cmd", transport: "stdio", config: {} }),
      draft({ name: "ok", transport: "stdio", config: { command: "npx" } }),
    ])
    expect(out.map((d) => d.name)).toEqual(["ok"])
  })

  it("drops remote drafts that are missing a url", () => {
    const out = dropInvalidDrafts([
      draft({ name: "no-url-http", transport: "http", config: {} }),
      draft({ name: "no-url-sse", transport: "sse", config: {} }),
      draft({ name: "ok", transport: "http", config: { url: "https://x" } }),
    ])
    expect(out.map((d) => d.name)).toEqual(["ok"])
  })

  it("keeps every well-formed draft", () => {
    const list = [
      draft({ name: "a", transport: "stdio", config: { command: "x" } }),
      draft({ name: "b", transport: "http", config: { url: "https://x" } }),
      draft({ name: "c", transport: "sse", config: { url: "https://x/sse" } }),
    ]
    expect(dropInvalidDrafts(list)).toEqual(list)
  })
})
