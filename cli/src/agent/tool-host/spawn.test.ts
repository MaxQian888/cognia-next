/**
 * @jest-environment node
 */
import path from "node:path"

import {
  COGNIA_TOOL_NAMESPACES,
  buildToolHostMcpServers,
  isCogniaProjectedTool,
  resolveToolBridgeScript,
} from "./spawn"
import { TOOL_HOST_ENV } from "./protocol"

type StdioServer = {
  name: string
  command: string
  args: string[]
  env: { name: string; value: string }[]
}

const envOf = (server: StdioServer) =>
  Object.fromEntries(server.env.map((e) => [e.name, e.value] as const))

describe("resolveToolBridgeScript", () => {
  it("honours an explicit override", () => {
    expect(
      resolveToolBridgeScript({ env: { COGNIA_TOOL_BRIDGE_SCRIPT: "/custom/bridge.mjs" } })
    ).toBe("/custom/bridge.mjs")
  })

  it("prefers a sidecar dir next to the executable (packaged dist layout)", () => {
    const adjacent = path.join("/opt/cognia", "sidecar", "cognia-tool-bridge.mjs")
    expect(
      resolveToolBridgeScript({
        env: {},
        execPath: "/opt/cognia/cognia-agent",
        exists: (p) => p === adjacent,
      })
    ).toBe(adjacent)
  })

  it("finds the in-repo bridge by walking up from this module", () => {
    const resolved = resolveToolBridgeScript({ env: {}, execPath: "/nowhere/bin" })
    expect(resolved.endsWith(path.join("sidecar", "cognia-tool-bridge.mjs"))).toBe(true)
  })

  it("fails loudly, with the override to set, when nothing is found", () => {
    expect(() =>
      resolveToolBridgeScript({ env: {}, execPath: "/nowhere/bin", exists: () => false })
    ).toThrow(/COGNIA_TOOL_BRIDGE_SCRIPT/)
  })
})

describe("buildToolHostMcpServers", () => {
  const base = { endpoint: "/tmp/th.sock", token: "tok", script: "/repo/sidecar/bridge.mjs" }

  it("attaches BOTH Cognia namespaces so tool prefixes match the built-in backend", () => {
    const servers = buildToolHostMcpServers({ ...base, packaged: false }) as StdioServer[]
    expect(servers.map((s) => s.name)).toEqual(["cognia-tools", "cognia-plugin-tools"])
  })

  it("runs the bridge script under node in dev", () => {
    const [tools] = buildToolHostMcpServers({ ...base, packaged: false }) as StdioServer[]
    expect(tools.command).toBe(process.execPath)
    expect(tools.args).toEqual(["/repo/sidecar/bridge.mjs"])
    expect(envOf(tools)).toMatchObject({
      [TOOL_HOST_ENV.socket]: "/tmp/th.sock",
      [TOOL_HOST_ENV.token]: "tok",
      [TOOL_HOST_ENV.server]: "cognia-tools",
    })
  })

  it("self-execs the binary with the role env when packaged (no system node)", () => {
    const [tools] = buildToolHostMcpServers({
      ...base,
      packaged: true,
      execPath: "/opt/cognia/cognia-agent",
    }) as StdioServer[]
    expect(tools.command).toBe("/opt/cognia/cognia-agent")
    expect(tools.args).toEqual([])
    expect(envOf(tools)).toMatchObject({
      COGNIA_ROLE: "tool-bridge",
      COGNIA_SIDECAR_SCRIPT: "/repo/sidecar/bridge.mjs",
    })
  })

  it("keeps the token out of argv — it is only ever an env value", () => {
    const servers = buildToolHostMcpServers({ ...base, packaged: false }) as StdioServer[]
    for (const server of servers) {
      expect(server.args.join(" ")).not.toContain("tok")
      expect(server.command).not.toContain("tok")
    }
  })

  it("can attach a single namespace when asked", () => {
    const servers = buildToolHostMcpServers({
      ...base,
      packaged: false,
      servers: ["cognia-plugin-tools"],
    }) as StdioServer[]
    expect(servers).toHaveLength(1)
    expect(envOf(servers[0])[TOOL_HOST_ENV.server]).toBe("cognia-plugin-tools")
  })
})

describe("isCogniaProjectedTool", () => {
  it("matches both projected namespaces", () => {
    expect(isCogniaProjectedTool("mcp__cognia-tools__read")).toBe(true)
    expect(isCogniaProjectedTool("mcp__cognia-plugin-tools__ask_user")).toBe(true)
  })

  it("never matches the agent's own or a user MCP tool", () => {
    expect(isCogniaProjectedTool("Read")).toBe(false)
    expect(isCogniaProjectedTool("mcp__github__create_issue")).toBe(false)
    expect(isCogniaProjectedTool(undefined)).toBe(false)
  })

  it("does not match a look-alike prefix", () => {
    expect(isCogniaProjectedTool("mcp__cognia-tools-evil__read")).toBe(false)
  })

  it("exposes the namespaces it matches on", () => {
    expect(COGNIA_TOOL_NAMESPACES).toEqual(["mcp__cognia-tools__", "mcp__cognia-plugin-tools__"])
  })
})
