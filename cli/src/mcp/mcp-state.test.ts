/**
 * @jest-environment node
 */
import {
  applyDisabled,
  mcpStatePath,
  mcpToolGateName,
  readDisabled,
  readDisabledTools,
  setDisabled,
  setDisabledTool,
  type McpStateFs,
} from "./mcp-state"
import type { McpServer } from "@cognia/agent-config-types"

function memFs(seed: Record<string, string> = {}): McpStateFs & { files: Record<string, string> } {
  const files = { ...seed }
  return {
    files,
    exists: (p) => p in files,
    readText: (p) => files[p],
    writeText: (p, data) => {
      files[p] = data
    },
  }
}

const server = (name: string): McpServer =>
  ({ id: `mcp_${name}`, name, transport: "stdio", config: {}, enabled: true }) as McpServer

describe("readDisabled", () => {
  it("returns an empty set when no state file exists", () => {
    expect(readDisabled("/home", memFs())).toEqual(new Set())
  })
  it("reads the disabled list", () => {
    const fs = memFs({ [mcpStatePath("/home")]: JSON.stringify({ disabled: ["a", "b"] }) })
    expect([...readDisabled("/home", fs)].sort()).toEqual(["a", "b"])
  })
  it("tolerates corrupt state", () => {
    const fs = memFs({ [mcpStatePath("/home")]: "{bad" })
    expect(readDisabled("/home", fs)).toEqual(new Set())
  })
})

describe("setDisabled", () => {
  it("adds then removes a name, persisting each time", () => {
    const fs = memFs()
    setDisabled("/home", "x", true, fs)
    expect(readDisabled("/home", fs).has("x")).toBe(true)
    setDisabled("/home", "x", false, fs)
    expect(readDisabled("/home", fs).has("x")).toBe(false)
  })
})

describe("applyDisabled", () => {
  it("marks disabled servers", () => {
    const out = applyDisabled([server("a"), server("b")], new Set(["a"]))
    expect(out.find((s) => s.name === "a")!.enabled).toBe(false)
    expect(out.find((s) => s.name === "b")!.enabled).toBe(true)
  })
})

describe("per-tool overlay", () => {
  it("toggles a tool without clobbering the server overlay", () => {
    const fs = memFs()
    setDisabled("/home", "github", true, fs)
    setDisabledTool("/home", mcpToolGateName("github", "create_issue"), true, fs)
    // Both overlays coexist in one file.
    expect(readDisabled("/home", fs).has("github")).toBe(true)
    expect(readDisabledTools("/home", fs).has("mcp__github__create_issue")).toBe(true)
    // Flipping the server back off does not drop the tool overlay.
    setDisabled("/home", "github", false, fs)
    expect(readDisabledTools("/home", fs).has("mcp__github__create_issue")).toBe(true)
  })

  it("removes a tool from the overlay", () => {
    const fs = memFs()
    const name = mcpToolGateName("brave", "search")
    setDisabledTool("/home", name, true, fs)
    expect(readDisabledTools("/home", fs).has(name)).toBe(true)
    setDisabledTool("/home", name, false, fs)
    expect(readDisabledTools("/home", fs).has(name)).toBe(false)
  })

  it("builds the gate's namespaced tool name", () => {
    expect(mcpToolGateName("github", "create_issue")).toBe("mcp__github__create_issue")
  })

  it("reads an empty tool set when absent", () => {
    expect(readDisabledTools("/home", memFs())).toEqual(new Set())
  })
})
