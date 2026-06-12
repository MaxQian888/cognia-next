/**
 * @jest-environment node
 */
import path from "node:path"

import { loadMcpServers, mcpConfigPaths, parseMcpConfig, type McpFs } from "./load-mcp-config"

function fakeFs(files: Record<string, string>): McpFs {
  return {
    exists: (p) => p in files,
    readText: (p) => {
      if (!(p in files)) throw new Error("ENOENT")
      return files[p]
    },
  }
}

const STDIO = JSON.stringify({
  mcpServers: { fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] } },
})
const HTTP = JSON.stringify({ mcpServers: { remote: { url: "https://example.com/mcp" } } })

describe("parseMcpConfig", () => {
  it("parses stdio + http entries into McpServer rows via the desktop normalizer", () => {
    const stdio = parseMcpConfig(STDIO)
    expect(stdio).toHaveLength(1)
    expect(stdio[0]).toMatchObject({ id: "mcp_fs", name: "fs", transport: "stdio", enabled: true })
    expect(stdio[0].config).toMatchObject({ command: "npx" })

    const http = parseMcpConfig(HTTP)
    expect(http[0].transport).toBe("http")
    expect(http[0].config).toMatchObject({ url: "https://example.com/mcp" })
  })

  it("accepts a bare name→entry map and skips invalid entries", () => {
    const text = JSON.stringify({ good: { command: "x" }, bad: { nonsense: true } })
    const rows = parseMcpConfig(text)
    expect(rows.map((r) => r.name)).toEqual(["good"])
  })

  it("returns nothing for malformed JSON", () => {
    expect(parseMcpConfig("{not json")).toEqual([])
  })
})

describe("loadMcpServers", () => {
  it("merges across files with project precedence (first name wins)", () => {
    const cwd = "/proj"
    const home = "/home"
    const projectFile = path.join(cwd, ".mcp.json")
    const homeFile = path.join(home, ".cognia", "mcp.json")
    const fs = fakeFs({
      [projectFile]: JSON.stringify({ mcpServers: { fs: { command: "project-fs" } } }),
      [homeFile]: JSON.stringify({
        mcpServers: { fs: { command: "home-fs" }, extra: { command: "e" } },
      }),
    })
    const servers = loadMcpServers([cwd, home], fs)
    const fsServer = servers.find((s) => s.name === "fs")!
    expect(fsServer.config.command).toBe("project-fs")
    expect(servers.map((s) => s.name).sort()).toEqual(["extra", "fs"])
  })

  it("skips absent files", () => {
    expect(loadMcpServers(["/nowhere"], fakeFs({}))).toEqual([])
  })

  it("loads a server from <home>/mcp.json — the path `/mcp add` writes to", () => {
    // The CLI home IS the `.cognia` dir (`resolveHome` → `~/.cognia`), and
    // `mcpAdd` writes `<home>/mcp.json`. The loader must read that exact file,
    // not `<home>/.cognia/mcp.json` (which would be `~/.cognia/.cognia/...`).
    const cwd = "/proj"
    const home = "/home/.cognia"
    const addedFile = path.join(home, "mcp.json")
    const fs = fakeFs({
      [addedFile]: JSON.stringify({ mcpServers: { added: { command: "x" } } }),
    })
    const servers = loadMcpServers([cwd, home], fs)
    expect(servers.map((s) => s.name)).toContain("added")
  })
})

describe("mcpConfigPaths", () => {
  it("lists .mcp.json, mcp.json, and .cognia/mcp.json per root", () => {
    expect(mcpConfigPaths(["/r"])).toEqual([
      path.join("/r", ".mcp.json"),
      path.join("/r", "mcp.json"),
      path.join("/r", ".cognia", "mcp.json"),
    ])
  })
})
