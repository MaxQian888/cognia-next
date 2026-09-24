/**
 * @jest-environment node
 */
import type { AcpMcpServerConfig } from "@/types/agent/external-agent"

import {
  buildCodexMcpServersConfig,
  toCodexMcpServerEntry,
  withCodexMcpServers,
} from "./codex-mcp-config"

const stdio = (name: string, extra: Partial<AcpMcpServerConfig> = {}): AcpMcpServerConfig =>
  ({ name, command: "node", args: ["bridge.mjs"], ...extra }) as AcpMcpServerConfig

describe("toCodexMcpServerEntry", () => {
  it("maps a stdio server, turning ACP's env LIST into Codex's table", () => {
    expect(
      toCodexMcpServerEntry(
        stdio("cognia-tools", {
          env: [
            { name: "COGNIA_TOOLHOST_SOCKET", value: "/tmp/x.sock" },
            { name: "COGNIA_TOOLHOST_TOKEN", value: "tok" },
          ],
        } as never)
      )
    ).toEqual({
      type: "stdio",
      command: "node",
      args: ["bridge.mjs"],
      env: { COGNIA_TOOLHOST_SOCKET: "/tmp/x.sock", COGNIA_TOOLHOST_TOKEN: "tok" },
    })
  })

  it("omits empty args and env rather than emitting empty tables", () => {
    expect(
      toCodexMcpServerEntry({ name: "bare", command: "srv", args: [], env: [] } as never)
    ).toEqual({ type: "stdio", command: "srv" })
  })

  it("maps an HTTP server, turning headers into a table", () => {
    expect(
      toCodexMcpServerEntry({
        type: "http",
        name: "remote",
        url: "https://example.test/mcp",
        headers: [{ name: "Authorization", value: "Bearer x" }],
      } as never)
    ).toEqual({
      type: "streamable_http",
      url: "https://example.test/mcp",
      http_headers: { Authorization: "Bearer x" },
    })
  })

  it("refuses SSE — Codex has no counterpart, and calling it HTTP would misdescribe it", () => {
    expect(
      toCodexMcpServerEntry({ type: "sse", name: "legacy", url: "https://x.test/sse" } as never)
    ).toBeNull()
  })

  it("refuses a row with neither a command nor a url", () => {
    expect(toCodexMcpServerEntry({ name: "empty" } as never)).toBeNull()
  })
})

describe("buildCodexMcpServersConfig", () => {
  it("keys the table by server name", () => {
    const table = buildCodexMcpServersConfig([stdio("cognia-tools"), stdio("cognia-plugin-tools")])
    expect(Object.keys(table ?? {})).toEqual(["cognia-tools", "cognia-plugin-tools"])
  })

  it("keeps the first of a duplicate name rather than silently replacing it", () => {
    const table = buildCodexMcpServersConfig([
      stdio("dup", { command: "first" } as never),
      stdio("dup", { command: "second" } as never),
    ])
    expect(table?.dup.command).toBe("first")
  })

  it("returns undefined when there is nothing to attach", () => {
    expect(buildCodexMcpServersConfig(undefined)).toBeUndefined()
    expect(buildCodexMcpServersConfig([])).toBeUndefined()
  })

  it("returns undefined when every row is unmappable", () => {
    expect(buildCodexMcpServersConfig([{ name: "empty" } as never])).toBeUndefined()
  })

  it("skips a row with no name — the table is keyed by it", () => {
    expect(buildCodexMcpServersConfig([{ command: "srv" } as never])).toBeUndefined()
  })
})

describe("withCodexMcpServers", () => {
  it("adds the table to a thread's config overrides", () => {
    const config = withCodexMcpServers({ model: "gpt-5" }, [stdio("cognia-tools")])
    expect(config).toMatchObject({
      model: "gpt-5",
      mcp_servers: { "cognia-tools": { type: "stdio", command: "node" } },
    })
  })

  it("creates the config object when there was none", () => {
    expect(withCodexMcpServers(undefined, [stdio("a")])).toMatchObject({
      mcp_servers: { a: { type: "stdio" } },
    })
  })

  it("leaves the config untouched when nothing maps", () => {
    const original = { model: "gpt-5" }
    expect(withCodexMcpServers(original, [])).toBe(original)
    expect(withCodexMcpServers(undefined, undefined)).toBeUndefined()
  })

  it("merges with a caller-supplied table, letting the caller's entry win", () => {
    const config = withCodexMcpServers(
      { mcp_servers: { existing: { type: "stdio", command: "theirs" } } },
      [stdio("cognia-tools")]
    )
    const table = (config as { mcp_servers: Record<string, { command?: string }> }).mcp_servers
    expect(Object.keys(table).sort()).toEqual(["cognia-tools", "existing"])
    expect(table.existing.command).toBe("theirs")
  })

  it("does not let an attached server silently replace a same-named override", () => {
    const config = withCodexMcpServers({ mcp_servers: { "cognia-tools": { command: "theirs" } } }, [
      stdio("cognia-tools", { command: "ours" } as never),
    ])
    const table = (config as { mcp_servers: Record<string, { command?: string }> }).mcp_servers
    expect(table["cognia-tools"].command).toBe("theirs")
  })
})
