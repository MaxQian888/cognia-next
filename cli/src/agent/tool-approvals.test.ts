/**
 * @jest-environment node
 */
import {
  readToolApprovals,
  readToolApprovalEntries,
  addToolApproval,
  removeToolApproval,
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

  it("persists to the canonical { approvals: [...] } shape", () => {
    const { fsx, files } = memFs()
    addToolApproval(HOME, "mcp__cognia-tools__write", fsx)
    const raw = files.get(toolApprovalsPath(HOME))!
    expect(JSON.parse(raw)).toEqual({ approvals: [{ tool: "mcp__cognia-tools__write" }] })
  })

  it("reads the legacy { allowed: [...] } shape for back-compat", () => {
    const { fsx, files } = memFs()
    files.set(toolApprovalsPath(HOME), JSON.stringify({ allowed: ["mcp__cognia-tools__bash"] }))
    expect(readToolApprovals(HOME, fsx).has("mcp__cognia-tools__bash")).toBe(true)
  })

  it("drops an expired approval (TTL)", () => {
    const { fsx } = memFs()
    addToolApproval(HOME, "mcp__cognia-tools__bash", fsx, { ttlMs: -1 })
    expect(readToolApprovals(HOME, fsx).size).toBe(0)
    // The raw entry is still stored (with its past expiry) until cleaned.
    expect(readToolApprovalEntries(HOME, fsx)[0].tool).toBe("mcp__cognia-tools__bash")
  })

  it("honours a future TTL", () => {
    const { fsx } = memFs()
    addToolApproval(HOME, "mcp__cognia-tools__bash", fsx, { ttlMs: 60_000 })
    expect(readToolApprovals(HOME, fsx).has("mcp__cognia-tools__bash")).toBe(true)
  })

  it("scopes a cwd-bound approval to its directory", () => {
    const { fsx } = memFs()
    addToolApproval(HOME, "mcp__cognia-tools__bash", fsx, { cwd: "/proj/a" })
    expect(readToolApprovals(HOME, fsx, "/proj/a").has("mcp__cognia-tools__bash")).toBe(true)
    expect(readToolApprovals(HOME, fsx, "/proj/b").has("mcp__cognia-tools__bash")).toBe(false)
    // A scoped grant requires a matching workspace; absence is not authority.
    expect(readToolApprovals(HOME, fsx).has("mcp__cognia-tools__bash")).toBe(false)
  })

  it("removes a single tool, leaving the others", () => {
    const { fsx } = memFs()
    addToolApproval(HOME, "mcp__cognia-tools__bash", fsx)
    addToolApproval(HOME, "mcp__cognia-tools__write", fsx)
    expect(removeToolApproval(HOME, "mcp__cognia-tools__bash", fsx)).toBe(true)
    expect(readToolApprovals(HOME, fsx).has("mcp__cognia-tools__bash")).toBe(false)
    expect(readToolApprovals(HOME, fsx).has("mcp__cognia-tools__write")).toBe(true)
    // Removing a non-existent tool reports false.
    expect(removeToolApproval(HOME, "mcp__cognia-tools__nope", fsx)).toBe(false)
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
    expect(JSON.parse(files.get(toolApprovalsPath(HOME))!)).toEqual({ approvals: [] })
  })

  it("clearing an empty store reports zero", () => {
    const { fsx } = memFs()
    expect(clearToolApprovals(HOME, fsx)).toBe(0)
  })
})

it("preserves independent grants for the same command in two workspaces", () => {
  const { fsx } = memFs()
  addToolApproval(HOME, "bash(pnpm test)", fsx, { cwd: "/project/a" })
  addToolApproval(HOME, "bash(pnpm test)", fsx, { cwd: "/project/b" })
  expect(readToolApprovalEntries(HOME, fsx)).toHaveLength(2)
  expect(readToolApprovals(HOME, fsx, "/project/a").has("bash(pnpm test)")).toBe(true)
  expect(readToolApprovals(HOME, fsx, "/project/b").has("bash(pnpm test)")).toBe(true)
  expect(readToolApprovals(HOME, fsx, "/project/c").has("bash(pnpm test)")).toBe(false)
})
