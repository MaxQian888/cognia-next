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

  describe("wisdom gate on workflowRun", () => {
    const at = (seed: number): PetEvent => ({ source: "workflow", kind: "workflowRun", at: seed })

    it("fires ~25% of runs at wisdom 0 (deterministic per seed)", () => {
      let fired = 0
      for (let seed = 0; seed < 100; seed++) {
        if (evaluateEventComment(at(seed), { wisdom: 0 })) fired++
      }
      expect(fired).toBe(25) // rolls 0..24 pass the 25% gate
    })

    it("always fires at wisdom 100", () => {
      for (let seed = 0; seed < 100; seed++) {
        expect(evaluateEventComment(at(seed), { wisdom: 100 })).not.toBeNull()
      }
    })

    it("scales the pass rate between the bounds", () => {
      let fired = 0
      for (let seed = 0; seed < 100; seed++) {
        if (evaluateEventComment(at(seed), { wisdom: 50 })) fired++
      }
      expect(fired).toBe(63) // 25 + 75 × 0.5 = 62.5 → rolls 0..62 pass
    })

    it("keeps milestones unaffected by wisdom 0", () => {
      expect(evaluateEventComment(ev("levelUp"), { wisdom: 0 })).not.toBeNull()
      expect(evaluateEventComment(ev("goalComplete"), { wisdom: 0 })).not.toBeNull()
    })

    it("omitted opts = today's always-fire behavior", () => {
      for (let seed = 0; seed < 10; seed++) {
        expect(evaluateEventComment(at(seed))).not.toBeNull()
      }
    })
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
