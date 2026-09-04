import type { PetInteractionGateState } from "@/types/pet"
import {
  INTERACTION_COOLDOWN_MS,
  canInteract,
  normalizeInteractionGate,
  remainingCooldownMs,
} from "./gate"

const T0 = 1_700_000_000_000
const empty: PetInteractionGateState = { lastAtByKind: {} }

function accept(state: PetInteractionGateState, kind: string, nowMs: number) {
  const res = canInteract({ nowMs, kind: kind as never, source: "user", state, hatched: true })
  if (!res.ok) throw new Error(`expected accept, got ${res.reason}`)
  return res.nextState
}

describe("canInteract", () => {
  it("accepts the first nurture and records when it happened", () => {
    const res = canInteract({
      nowMs: T0,
      kind: "fed",
      source: "user",
      state: empty,
      hatched: true,
    })
    expect(res).toEqual({ ok: true, nextState: { lastAtByKind: { fed: T0 } } })
  })

  it("refuses the same nurture inside its cooldown and says when it is ready", () => {
    const state = accept(empty, "fed", T0)
    const res = canInteract({
      nowMs: T0 + 500,
      kind: "fed",
      source: "user",
      state,
      hatched: true,
    })
    expect(res).toEqual({
      ok: false,
      reason: "cooldown",
      readyAtMs: T0 + INTERACTION_COOLDOWN_MS.fed,
    })
  })

  it("accepts again once the cooldown has elapsed", () => {
    const state = accept(empty, "fed", T0)
    const res = canInteract({
      nowMs: T0 + INTERACTION_COOLDOWN_MS.fed,
      kind: "fed",
      source: "user",
      state,
      hatched: true,
    })
    expect(res.ok).toBe(true)
  })

  it("cools each kind independently", () => {
    const state = accept(empty, "fed", T0)
    const res = canInteract({
      nowMs: T0 + 10,
      kind: "played",
      source: "user",
      state,
      hatched: true,
    })
    expect(res.ok).toBe(true)
  })

  it("holds a treat far longer than a feed", () => {
    expect(INTERACTION_COOLDOWN_MS.treated).toBeGreaterThan(INTERACTION_COOLDOWN_MS.fed)
  })

  describe("the spam paths this exists to stop", () => {
    it.each(["user", "plugin", "system"] as const)(
      "lets a %s subject through exactly once per cooldown, however fast it asks",
      (source) => {
        let state = empty
        let accepted = 0
        for (let i = 0; i < 50; i += 1) {
          const res = canInteract({ nowMs: T0 + i, kind: "fed", source, state, hatched: true })
          if (res.ok) {
            accepted += 1
            state = res.nextState
          }
        }
        // 50 requests inside 50ms. A held hotkey, a hammered overlay body-tap,
        // and a looping plugin all collapse to one award.
        expect(accepted).toBe(1)
      }
    )
  })

  describe("ambient events", () => {
    it.each(["chat", "goal", "scheduler", "workflow", "terminal", "capture"] as const)(
      "never throttles the %s source, whose events report real work",
      (source) => {
        let state = empty
        for (let i = 0; i < 5; i += 1) {
          const res = canInteract({ nowMs: T0 + i, kind: "fed", source, state, hatched: true })
          expect(res.ok).toBe(true)
          if (res.ok) state = res.nextState
        }
        // Untouched: an ambient event must not consume a driven cooldown slot.
        expect(state).toEqual(empty)
      }
    )

    it("passes through a kind that has no cooldown at all", () => {
      const res = canInteract({
        nowMs: T0,
        kind: "levelUp",
        source: "user",
        state: empty,
        hatched: true,
      })
      expect(res).toEqual({ ok: true, nextState: empty })
    })

    it("leaves `talked` to the speak limiter rather than cooling it", () => {
      expect(INTERACTION_COOLDOWN_MS.talked).toBeUndefined()
      let state = empty
      for (let i = 0; i < 5; i += 1) {
        const res = canInteract({
          nowMs: T0 + i,
          kind: "talked",
          source: "user",
          state,
          hatched: true,
        })
        expect(res.ok).toBe(true)
        if (res.ok) state = res.nextState
      }
    })
  })

  describe("hatching", () => {
    it("refuses to nurture an unhatched egg instead of silently accruing XP", () => {
      const res = canInteract({
        nowMs: T0,
        kind: "fed",
        source: "user",
        state: empty,
        hatched: false,
      })
      expect(res).toEqual({ ok: false, reason: "not-hatched" })
    })

    it("still lets the egg grow from ambient work", () => {
      const res = canInteract({
        nowMs: T0,
        kind: "fed",
        source: "goal",
        state: empty,
        hatched: false,
      })
      expect(res.ok).toBe(true)
    })
  })
})

describe("normalizeInteractionGate", () => {
  it("defaults a legacy row with no gate", () => {
    expect(normalizeInteractionGate(undefined)).toEqual({ lastAtByKind: {} })
  })

  it("drops malformed timestamps rather than trusting them", () => {
    const dirty = {
      lastAtByKind: { fed: T0, played: NaN, petted: -1, slept: "soon" },
    } as unknown as PetInteractionGateState
    expect(normalizeInteractionGate(dirty)).toEqual({ lastAtByKind: { fed: T0 } })
  })
})

describe("remainingCooldownMs", () => {
  it("counts down and floors at zero", () => {
    const state = accept(empty, "treated", T0)
    expect(remainingCooldownMs(state, "treated", T0)).toBe(INTERACTION_COOLDOWN_MS.treated)
    expect(remainingCooldownMs(state, "treated", T0 + 4000)).toBe(
      INTERACTION_COOLDOWN_MS.treated - 4000
    )
    expect(remainingCooldownMs(state, "treated", T0 + 999_999)).toBe(0)
  })

  it("is zero for a kind that was never used", () => {
    expect(remainingCooldownMs(empty, "fed", T0)).toBe(0)
  })
})
