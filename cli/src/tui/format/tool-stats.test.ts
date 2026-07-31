/**
 * @jest-environment node
 */
import { formatToolStatRow, topToolStats } from "./tool-stats"

describe("topToolStats", () => {
  it("returns [] for empty stats", () => {
    expect(topToolStats({})).toEqual([])
  })

  it("sorts by call count descending", () => {
    const rows = topToolStats({
      read: { calls: 12, errors: 0 },
      bash: { calls: 4, errors: 1 },
      grep: { calls: 7, errors: 0 },
    })
    expect(rows.map((r) => r.name)).toEqual(["read", "grep", "bash"])
  })

  it("breaks ties by display name", () => {
    const rows = topToolStats({
      zebra: { calls: 3, errors: 0 },
      alpha: { calls: 3, errors: 0 },
    })
    expect(rows.map((r) => r.name)).toEqual(["alpha", "zebra"])
  })

  it("normalizes mcp/plugin names", () => {
    const rows = topToolStats({ mcp__github__create_issue: { calls: 2, errors: 0 } })
    expect(rows[0].name).toBe("github:create_issue")
  })

  it("limits to the top N", () => {
    const stats = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`t${i}`, { calls: i, errors: 0 }])
    )
    expect(topToolStats(stats, 3)).toHaveLength(3)
  })

  it("returns [] for a non-positive limit", () => {
    expect(topToolStats({ read: { calls: 1, errors: 0 } }, 0)).toEqual([])
  })
})

describe("formatToolStatRow", () => {
  it("omits the error suffix when there are no errors", () => {
    expect(formatToolStatRow({ name: "read", calls: 12, errors: 0 })).toBe("read ×12")
  })

  it("appends an error count when present", () => {
    expect(formatToolStatRow({ name: "bash", calls: 4, errors: 1 })).toBe("bash ×4 (1✗)")
  })
})
