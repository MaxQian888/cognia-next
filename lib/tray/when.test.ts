import { evaluateWhen, __resetWhenCacheForTesting } from "./when"
import type { TrayStateSnapshot } from "./types"

const baseSnapshot: TrayStateSnapshot = {
  goal: { active: false, paused: false },
  automation: { running: false, armed: true },
  chat: { streaming: false, hasActiveSession: false },
  platform: { os: "windows" },
  app: { autostart: false, version: "0.0.0" },
}

afterEach(() => __resetWhenCacheForTesting())

describe("evaluateWhen", () => {
  it("returns true when expression is absent or empty", () => {
    expect(evaluateWhen(undefined, baseSnapshot)).toBe(true)
    expect(evaluateWhen("", baseSnapshot)).toBe(true)
    expect(evaluateWhen("   ", baseSnapshot)).toBe(true)
  })

  it("looks up dotted paths against the snapshot", () => {
    expect(evaluateWhen("automation.armed", baseSnapshot)).toBe(true)
    expect(evaluateWhen("automation.running", baseSnapshot)).toBe(false)
    expect(evaluateWhen("goal.active", baseSnapshot)).toBe(false)
  })

  it("handles platform predicates by comparing os string", () => {
    expect(evaluateWhen("platform.windows", baseSnapshot)).toBe(true)
    expect(evaluateWhen("platform.macos", baseSnapshot)).toBe(false)
    const mac: TrayStateSnapshot = { ...baseSnapshot, platform: { os: "macos" } }
    expect(evaluateWhen("platform.macos", mac)).toBe(true)
  })

  it("applies negation", () => {
    expect(evaluateWhen("!automation.running", baseSnapshot)).toBe(true)
    expect(evaluateWhen("!!automation.armed", baseSnapshot)).toBe(true)
  })

  it("supports && and || with normal short-circuiting", () => {
    const goalRunning: TrayStateSnapshot = {
      ...baseSnapshot,
      goal: { active: true, paused: false },
    }
    expect(evaluateWhen("goal.active && !automation.running", goalRunning)).toBe(true)
    expect(evaluateWhen("goal.active || automation.running", baseSnapshot)).toBe(false)
    expect(evaluateWhen("goal.active || automation.armed", baseSnapshot)).toBe(true)
  })

  it("handles parenthesised groups", () => {
    const goalRunning: TrayStateSnapshot = {
      ...baseSnapshot,
      goal: { active: true, paused: false },
    }
    expect(
      evaluateWhen("(goal.active || automation.running) && !chat.streaming", goalRunning)
    ).toBe(true)
  })

  it("treats unknown predicates as false rather than throwing", () => {
    expect(evaluateWhen("totally.fake.path", baseSnapshot)).toBe(false)
    expect(evaluateWhen("automation.bogus", baseSnapshot)).toBe(false)
  })

  it("surfaces parse errors for bad syntax", () => {
    expect(() => evaluateWhen("&& goal.active", baseSnapshot)).toThrow()
    expect(() => evaluateWhen("goal.active &&", baseSnapshot)).toThrow()
    expect(() => evaluateWhen("(goal.active", baseSnapshot)).toThrow()
  })
})
