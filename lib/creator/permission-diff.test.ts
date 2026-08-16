import { approvalCoversDiff, computePermissionDiff } from "./permission-diff"

describe("computePermissionDiff", () => {
  it("splits capabilities into added, removed and unchanged", () => {
    const diff = computePermissionDiff({
      current: ["fs.read", "net.fetch"],
      proposed: ["fs.read", "fs.write"],
    })
    expect(diff.added).toEqual(["fs.write"])
    expect(diff.removed).toEqual(["net.fetch"])
    expect(diff.changes.filter((c) => c.change === "unchanged").map((c) => c.capability)).toEqual([
      "fs.read",
    ])
  })

  it("requires approval only when something is added", () => {
    expect(
      computePermissionDiff({ current: ["fs.read"], proposed: ["fs.read", "fs.write"] })
        .requiresApproval
    ).toBe(true)
  })

  // Narrowing is always safe; prompting for it trains users to click through.
  it("does not require approval for a pure removal", () => {
    const diff = computePermissionDiff({ current: ["fs.read", "fs.write"], proposed: ["fs.read"] })
    expect(diff.removed).toEqual(["fs.write"])
    expect(diff.requiresApproval).toBe(false)
  })

  it("does not require approval when nothing changed", () => {
    expect(
      computePermissionDiff({ current: ["fs.read"], proposed: ["fs.read"] }).requiresApproval
    ).toBe(false)
  })

  it("requires approval for a first-time grant against an empty current set", () => {
    expect(computePermissionDiff({ current: [], proposed: ["fs.write"] }).requiresApproval).toBe(
      true
    )
  })

  it("orders changes added → removed → unchanged, alphabetically within each", () => {
    const diff = computePermissionDiff({
      current: ["z.keep", "a.drop"],
      proposed: ["z.keep", "b.add", "a.add"],
    })
    expect(diff.changes.map((c) => `${c.change}:${c.capability}`)).toEqual([
      "added:a.add",
      "added:b.add",
      "removed:a.drop",
      "unchanged:z.keep",
    ])
  })

  it("trims whitespace and drops empty ids", () => {
    const diff = computePermissionDiff({ current: [" fs.read "], proposed: ["fs.read", "  "] })
    expect(diff.added).toEqual([])
    expect(diff.removed).toEqual([])
  })

  it("deduplicates a capability listed twice", () => {
    const diff = computePermissionDiff({ current: [], proposed: ["fs.write", "fs.write"] })
    expect(diff.added).toEqual(["fs.write"])
  })

  it("attaches a rationale when the generator supplied one", () => {
    const diff = computePermissionDiff({
      current: [],
      proposed: ["net.fetch"],
      rationales: { "net.fetch": "fetches the changelog" },
    })
    expect(diff.changes[0]).toEqual({
      capability: "net.fetch",
      change: "added",
      rationale: "fetches the changelog",
    })
  })

  // No implied hierarchy: Creator does not know what a subsystem treats as
  // implied, and guessing would approve capabilities the user never saw.
  it("does not treat a broader capability as covering a narrower one", () => {
    const diff = computePermissionDiff({ current: ["fs.write"], proposed: ["fs.read"] })
    expect(diff.added).toEqual(["fs.read"])
    expect(diff.requiresApproval).toBe(true)
  })
})

describe("approvalCoversDiff", () => {
  it("passes trivially when nothing needs approval", () => {
    const diff = computePermissionDiff({ current: ["fs.read"], proposed: ["fs.read"] })
    expect(approvalCoversDiff([], diff)).toBe(true)
  })

  it("passes when every addition was approved", () => {
    const diff = computePermissionDiff({ current: [], proposed: ["fs.write", "net.fetch"] })
    expect(approvalCoversDiff(["net.fetch", "fs.write"], diff)).toBe(true)
  })

  // The smuggling case: a second generation pass asks for one more capability
  // and must not ride in on the earlier, smaller approval.
  it("fails when a regenerated proposal adds a capability the approval did not cover", () => {
    const diff = computePermissionDiff({ current: [], proposed: ["fs.write", "proc.spawn"] })
    expect(approvalCoversDiff(["fs.write"], diff)).toBe(false)
  })

  it("still passes when the approval covers more than the diff asks for", () => {
    const diff = computePermissionDiff({ current: [], proposed: ["fs.write"] })
    expect(approvalCoversDiff(["fs.write", "net.fetch"], diff)).toBe(true)
  })

  it("compares trimmed ids", () => {
    const diff = computePermissionDiff({ current: [], proposed: ["fs.write"] })
    expect(approvalCoversDiff([" fs.write "], diff)).toBe(true)
  })
})
