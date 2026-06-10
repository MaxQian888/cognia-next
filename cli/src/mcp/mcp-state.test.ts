/**
 * @jest-environment node
 */
import {
  applyDisabled,
  mcpStatePath,
  readDisabled,
  setDisabled,
  type McpStateFs,
} from "./mcp-state"
import type { McpServer } from "@/lib/claude/types"

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
