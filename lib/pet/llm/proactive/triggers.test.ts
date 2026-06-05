import {
  PROACTIVE_CLAIMED_KINDS,
  evaluateEventComment,
  evaluateGreeting,
  evaluateIdle,
} from "./triggers"
import type { PetEvent, PetNeeds } from "@/types/pet"

const NOW = 1_000_000_000

function ev(kind: PetEvent["kind"]): PetEvent {
  return { source: "system", kind, at: NOW }
}

function needs(partial: Partial<PetNeeds> = {}): PetNeeds {
  return { energy: 80, mood: 80, bond: 80, lastTickAt: "2026-06-05T00:00:00Z", ...partial }
}

describe("evaluateEventComment", () => {
  it("fires for every claimed milestone kind", () => {
    for (const kind of PROACTIVE_CLAIMED_KINDS) {
      const d = evaluateEventComment(ev(kind))
      expect(d?.trigger).toBe("event")
      expect(d?.topicSeed.length).toBeGreaterThan(0)
    }
  })

  it("ignores radar and interaction kinds", () => {
    expect(evaluateEventComment(ev("success"))).toBeNull()
    expect(evaluateEventComment(ev("error"))).toBeNull()
    expect(evaluateEventComment(ev("fed"))).toBeNull()
    expect(evaluateEventComment(ev("talked"))).toBeNull()
  })
})

describe("evaluateIdle", () => {
  const threshold = 10 * 60_000

  it("requires a known activity timestamp past the threshold", () => {
    expect(
      evaluateIdle({
        nowMs: NOW,
        lastActivityAtMs: null,
        needs: needs(),
        idleThresholdMs: threshold,
      })
    ).toBeNull()
    expect(
      evaluateIdle({
        nowMs: NOW,
        lastActivityAtMs: NOW - threshold + 1,
        needs: needs(),
        idleThresholdMs: threshold,
      })
    ).toBeNull()
    expect(
      evaluateIdle({
        nowMs: NOW,
        lastActivityAtMs: NOW - threshold - 1,
        needs: needs(),
        idleThresholdMs: threshold,
      })?.trigger
    ).toBe("idle")
  })

  it("seeds from the most pressing low need", () => {
    const base = { nowMs: NOW, lastActivityAtMs: NOW - threshold - 1, idleThresholdMs: threshold }
    expect(evaluateIdle({ ...base, needs: needs({ energy: 10 }) })?.topicSeed).toMatch(
      /energy|sleepy/
    )
    expect(evaluateIdle({ ...base, needs: needs({ mood: 10 }) })?.topicSeed).toMatch(
      /mood|attention/
    )
    expect(evaluateIdle({ ...base, needs: needs({ bond: 10 }) })?.topicSeed).toMatch(/miss|bond/)
    expect(evaluateIdle({ ...base, needs: needs() })?.topicSeed).toMatch(/bored|playful/)
  })
})

describe("evaluateGreeting", () => {
  const day = "2026-06-05"

  it("fires the morning window between 05:00 and 10:59", () => {
    const d = evaluateGreeting({ nowMs: NOW, greetedWindows: [], dayKey: day, hour: 8 })
    expect(d?.trigger).toBe("greeting")
    expect(d?.greetingWindowKey).toBe(`${day}:morning`)
  })

  it("fires the late-night window across midnight (23:00–03:59)", () => {
    expect(
      evaluateGreeting({ nowMs: NOW, greetedWindows: [], dayKey: day, hour: 23 })?.greetingWindowKey
    ).toBe(`${day}:lateNight`)
    expect(
      evaluateGreeting({ nowMs: NOW, greetedWindows: [], dayKey: day, hour: 2 })?.greetingWindowKey
    ).toBe(`${day}:lateNight`)
  })

  it("is silent outside windows and after the window was used", () => {
    expect(evaluateGreeting({ nowMs: NOW, greetedWindows: [], dayKey: day, hour: 14 })).toBeNull()
    expect(
      evaluateGreeting({ nowMs: NOW, greetedWindows: [`${day}:morning`], dayKey: day, hour: 8 })
    ).toBeNull()
  })
})
