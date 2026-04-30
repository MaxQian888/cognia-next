import type { McpServer } from "@/lib/claude/types"

import { VSCODE_AGENT } from "./vscode"

function mkServer(partial: Pick<McpServer, "name" | "transport" | "config">): McpServer {
  return {
    id: `mcp_${partial.name}`,
    enabled: true,
    appsEnabled: {},
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  }
}

describe("vscode adapter — metadata", () => {
  it("is a writable JSONC adapter", () => {
    expect(VSCODE_AGENT.id).toBe("vscode")
    expect(VSCODE_AGENT.writable).toBe(true)
    expect(VSCODE_AGENT.format).toBe("jsonc")
  })
})

describe("vscode adapter — parse", () => {
  it("returns [] for null / non-object", () => {
    expect(VSCODE_AGENT.parse(null)).toEqual([])
    expect(VSCODE_AGENT.parse("x")).toEqual([])
    expect(VSCODE_AGENT.parse([])).toEqual([])
  })

  it("returns [] when servers is missing or non-object", () => {
    expect(VSCODE_AGENT.parse({})).toEqual([])
    expect(VSCODE_AGENT.parse({ servers: 7 })).toEqual([])
  })

  it("ignores `mcpServers` even if present (the wrong key for VS Code)", () => {
    expect(VSCODE_AGENT.parse({ mcpServers: { x: { command: "x" } } })).toEqual([])
  })

  it("reads from `servers` and infers transports", () => {
    const drafts = VSCODE_AGENT.parse({
      servers: {
        playwright: { type: "stdio", command: "npx", args: ["-y", "playwright"] },
        gh: { type: "http", url: "https://api.github/x" },
        bogus: { weird: 1 },
      },
    })
    const byName = Object.fromEntries(drafts.map((d) => [d.name, d]))
    expect(byName.playwright.transport).toBe("stdio")
    expect(byName.gh.transport).toBe("http")
    expect(byName.bogus).toBeUndefined()
  })
})

describe("vscode adapter — project", () => {
  it("creates a fresh tree from null", () => {
    const out = VSCODE_AGENT.project(null, [
      mkServer({ name: "p", transport: "stdio", config: { command: "x" } }),
    ]) as { servers: Record<string, Record<string, unknown>> }
    expect(out.servers.p).toEqual({ type: "stdio", command: "x" })
  })

  it("creates a fresh tree from non-object existing", () => {
    const out = VSCODE_AGENT.project(7, [
      mkServer({ name: "p", transport: "stdio", config: { command: "x" } }),
    ]) as { servers: Record<string, Record<string, unknown>> }
    expect(out.servers.p).toEqual({ type: "stdio", command: "x" })
  })

  it("preserves user inputs[] array and unmanaged servers", () => {
    const out = VSCODE_AGENT.project(
      {
        servers: { keep: { type: "stdio", command: "k" } },
        inputs: [{ id: "tok" }],
      },
      [mkServer({ name: "new", transport: "http", config: { url: "https://x" } })]
    ) as Record<string, unknown>
    expect(out.inputs).toEqual([{ id: "tok" }])
    const servers = out.servers as Record<string, Record<string, unknown>>
    expect(servers.keep).toEqual({ type: "stdio", command: "k" })
    expect(servers.new).toEqual({ type: "http", url: "https://x" })
  })

  it("drops managed names absent from servers", () => {
    const out = VSCODE_AGENT.project(
      { servers: { drop: { type: "stdio", command: "d" }, keep: { type: "stdio", command: "k" } } },
      [],
      new Set(["drop"])
    ) as { servers: Record<string, Record<string, unknown>> }
    expect(out.servers.drop).toBeUndefined()
    expect(out.servers.keep).toEqual({ type: "stdio", command: "k" })
  })

  it("ignores servers when it's not an object", () => {
    const out = VSCODE_AGENT.project({ servers: "no" }, [
      mkServer({ name: "x", transport: "stdio", config: { command: "x" } }),
    ]) as { servers: Record<string, unknown> }
    expect(Object.keys(out.servers)).toEqual(["x"])
  })
})
