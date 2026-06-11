import {
  buildStatusSection,
  deriveStatusKey,
  truncateTitle,
  GOAL_TITLE_MAX,
} from "./status-section"
import type { TrayStateSnapshot } from "./types"

function snap(overrides: Partial<TrayStateSnapshot> = {}): TrayStateSnapshot {
  return {
    goal: { active: false, paused: false },
    automation: { running: false, armed: true },
    chat: { streaming: false, hasActiveSession: false },
    platform: { os: "windows" },
    app: { autostart: false, version: "1.2.3" },
    ...overrides,
  }
}

describe("deriveStatusKey", () => {
  it("returns idle when nothing is happening", () => {
    expect(deriveStatusKey(snap())).toBe("tray.status.idle")
  })

  it("prioritises automation over every other state", () => {
    const key = deriveStatusKey(
      snap({
        automation: { running: true, armed: true },
        goal: { active: true, paused: false },
        chat: { streaming: true, hasActiveSession: true },
      })
    )
    expect(key).toBe("tray.status.automationRunning")
  })

  it("ranks an active goal above raw streaming", () => {
    const key = deriveStatusKey(
      snap({
        goal: { active: true, paused: false },
        chat: { streaming: true, hasActiveSession: true },
      })
    )
    expect(key).toBe("tray.status.goalRunning")
  })

  it("reports a paused goal", () => {
    expect(deriveStatusKey(snap({ goal: { active: false, paused: true } }))).toBe(
      "tray.status.goalPaused"
    )
  })

  it("falls back to streaming when only the chat is active", () => {
    expect(deriveStatusKey(snap({ chat: { streaming: true, hasActiveSession: true } }))).toBe(
      "tray.status.streaming"
    )
  })
})

describe("truncateTitle", () => {
  it("collapses whitespace and leaves short text intact", () => {
    expect(truncateTitle("  review   the   PR ")).toBe("review the PR")
  })

  it("truncates with an ellipsis past the cap", () => {
    const long = "a".repeat(GOAL_TITLE_MAX + 20)
    const out = truncateTitle(long)
    expect(out.length).toBeLessThanOrEqual(GOAL_TITLE_MAX)
    expect(out.endsWith("…")).toBe(true)
  })

  it("respects a custom cap", () => {
    expect(truncateTitle("hello world", 5)).toBe("hell…")
  })
})

describe("buildStatusSection", () => {
  it("always emits exactly one disabled primary row when idle", () => {
    const rows = buildStatusSection(snap())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: "action",
      id: "tray.status.primary",
      label: "tray.status.idle",
      disabled: true,
      payload: { kind: "native", action: "noop" },
    })
  })

  it("appends a redacted goal-detail row when a goal is open", () => {
    const rows = buildStatusSection(
      snap({ goal: { active: true, paused: false, title: "Ship the tray upgrade" } })
    )
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({
      id: "tray.status.goal",
      label: "Ship the tray upgrade",
      disabled: true,
    })
  })

  it("omits the goal row when there is no title even if a goal is open", () => {
    const rows = buildStatusSection(snap({ goal: { active: true, paused: false } }))
    expect(rows).toHaveLength(1)
  })

  it("shows the goal detail for a paused goal too", () => {
    const rows = buildStatusSection(
      snap({ goal: { active: false, paused: true, title: "Paused work" } })
    )
    expect(rows.map((r) => ("id" in r ? r.id : ""))).toEqual([
      "tray.status.primary",
      "tray.status.goal",
    ])
  })
})
