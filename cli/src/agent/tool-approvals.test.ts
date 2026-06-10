/**
 * @jest-environment node
 */
import {
  readToolApprovals,
  addToolApproval,
  clearToolApprovals,
  toolApprovalsPath,
  type ToolApprovalsFs,
} from "./tool-approvals"

const HOME = "/home/u/.cognia"

function memFs() {
  const files = new Map<string, string>()
  const fsx: ToolApprovalsFs = {
    exists: (p) => files.has(p),
    readText: (p) => files.get(p) ?? "",
    writeText: (p, data) => files.set(p, data),
  }
  return { fsx, files }
}

describe("tool-approvals", () => {
  it("returns an empty set when the file is missing", () => {
    const { fsx } = memFs()
    expect(readToolApprovals(HOME, fsx).size).toBe(0)
  })

  it("adds a tool and reads it back", () => {
    const { fsx } = memFs()
    addToolApproval(HOME, "mcp__cognia-tools__bash", fsx)
    const set = readToolApprovals(HOME, fsx)
    expect(set.has("mcp__cognia-tools__bash")).toBe(true)
  })

  it("persists to the canonical { allowed: [...] } shape", () => {
    const { fsx, files } = memFs()
    addToolApproval(HOME, "mcp__cognia-tools__write", fsx)
    const raw = files.get(toolApprovalsPath(HOME))!
    expect(JSON.parse(raw)).toEqual({ allowed: ["mcp__cognia-tools__write"] })
  })

  it("de-dupes repeated additions", () => {
    const { fsx } = memFs()
    addToolApproval(HOME, "mcp__cognia-tools__bash", fsx)
    const set = addToolApproval(HOME, "mcp__cognia-tools__bash", fsx)
    expect([...set]).toEqual(["mcp__cognia-tools__bash"])
  })

  it("accumulates distinct tools", () => {
    const { fsx } = memFs()
    addToolApproval(HOME, "mcp__cognia-tools__bash", fsx)
    addToolApproval(HOME, "mcp__cognia-tools__write", fsx)
    expect(readToolApprovals(HOME, fsx).size).toBe(2)
  })

  it("treats corrupt JSON as empty", () => {
    const { fsx, files } = memFs()
    files.set(toolApprovalsPath(HOME), "{not json")
    expect(readToolApprovals(HOME, fsx).size).toBe(0)
  })

  it("clears all approvals and reports the count cleared", () => {
    const { fsx, files } = memFs()
    addToolApproval(HOME, "mcp__cognia-tools__bash", fsx)
    addToolApproval(HOME, "mcp__cognia-tools__write", fsx)
    expect(clearToolApprovals(HOME, fsx)).toBe(2)
    expect(readToolApprovals(HOME, fsx).size).toBe(0)
    expect(JSON.parse(files.get(toolApprovalsPath(HOME))!)).toEqual({ allowed: [] })
  })

  it("clearing an empty store reports zero", () => {
    const { fsx } = memFs()
    expect(clearToolApprovals(HOME, fsx)).toBe(0)
  })
})
