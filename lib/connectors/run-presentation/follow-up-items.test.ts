import type { RunProjectionSnapshot } from "@/types/execution/run"

import { buildFollowUpItems, followUpHintLine, FOLLOW_UP_TTL_MS } from "./follow-up-items"

function snapshot(over: Partial<RunProjectionSnapshot> = {}): RunProjectionSnapshot {
  return {
    runId: "run-1",
    kind: "team",
    title: "Ship it",
    status: "running",
    revision: 3,
    startedAt: 0,
    updatedAt: 0,
    progress: { completed: 0, total: 0, trustworthy: false },
    activeSteps: [],
    recentSteps: [],
    pendingSteps: [],
    pendingStepCount: 0,
    elapsedMs: 0,
    artifacts: [],
    allowedActions: ["pause", "stop", "open_details"],
    ...over,
  }
}

describe("buildFollowUpItems", () => {
  it("offers the state-changing verbs plus status", () => {
    expect(buildFollowUpItems(snapshot()).map((item) => item.action)).toEqual([
      "pause",
      "stop",
      "status",
    ])
  })

  it("never spends a slot on open_details", () => {
    // It is a link, not a control; including it would push out a verb that
    // actually does something.
    const items = buildFollowUpItems(snapshot({ allowedActions: ["open_details"] }))
    expect(items.map((item) => item.action)).toEqual(["status"])
  })

  it("caps at three so a card body stays readable", () => {
    const items = buildFollowUpItems(
      snapshot({ allowedActions: ["approve", "deny", "stop", "pause", "open_details"] })
    )
    expect(items).toHaveLength(3)
  })

  it("carries a sanitized interrupt id when one is pending", () => {
    const items = buildFollowUpItems(
      snapshot({
        allowedActions: ["approve", "deny"],
        pendingInterrupt: { id: "int 1/../x", title: "Approve?" },
      })
    )
    expect(items[0]).toHaveProperty("interruptId")
    expect((items[0] as { interruptId: string }).interruptId).not.toContain("/")
  })

  it("labels every verb in both locales", () => {
    for (const item of buildFollowUpItems(snapshot())) {
      expect(item.content.length).toBeGreaterThan(0)
      expect(item.localizedContent.length).toBeGreaterThan(0)
    }
  })

  it("keeps the registration window at ten minutes", () => {
    expect(FOLLOW_UP_TTL_MS).toBe(600_000)
  })
})

describe("followUpHintLine", () => {
  it("prints the verbs for a platform with no native bubbles", () => {
    // Rendering is a capability; control is not. A platform without bubbles
    // still gets the verbs, and typing one back matches the registration.
    expect(followUpHintLine(buildFollowUpItems(snapshot()), false)).toBe(
      "Reply to act: Pause / Stop / View status"
    )
    expect(followUpHintLine(buildFollowUpItems(snapshot()), true)).toBe(
      "回复以操作：暂停 / 停止 / 查看状态"
    )
  })

  it("returns undefined when there is nothing to offer", () => {
    expect(followUpHintLine([], false)).toBeUndefined()
  })
})
