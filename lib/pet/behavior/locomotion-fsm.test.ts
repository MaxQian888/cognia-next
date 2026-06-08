import { mulberry32 } from "@/lib/pet/bones/prng"
import {
  resolveGroundTop,
  resolvePlatformTop,
  type Platform,
  type WorkAreaRect,
} from "@/lib/pet/overlay-geometry"
import {
  beginThrow,
  createLocomotionState,
  stepLocomotion,
  type LocomotionFsmState,
  type LocomotionInput,
} from "./locomotion-fsm"
import { INTERACTION_WINDOW_MS, RECHECK_DELAY_MS, resolveWanderTuning } from "./wander-config"

const AREA: WorkAreaRect = { x: 0, y: 0, width: 1920, height: 1040 }
const WIN = { width: 288, height: 288 }
const GROUND = resolveGroundTop(AREA, WIN.height) // 752

function input(partial: Partial<LocomotionInput> = {}): LocomotionInput {
  return {
    nowMs: 0,
    paused: false,
    wanderEnabled: true,
    onlyAfterInteraction: false,
    lastInteractionAtMs: null,
    range: "full",
    workArea: AREA,
    windowWidth: WIN.width,
    windowHeight: WIN.height,
    tuning: resolveWanderTuning("normal", false),
    platforms: [],
    climbEnabled: false,
    rng: mulberry32(42),
    ...partial,
  }
}

function grounded(x = 400): LocomotionFsmState {
  return createLocomotionState(x, GROUND)
}

/** Step with a fixed dt, advancing nowMs alongside. */
function run(
  state: LocomotionFsmState,
  base: LocomotionInput,
  frames: number,
  dtMs = 16
): { state: LocomotionFsmState; nowMs: number } {
  let cur = state
  let now = base.nowMs
  for (let i = 0; i < frames; i++) {
    now += dtMs
    cur = stepLocomotion(cur, { ...base, nowMs: now }, dtMs)
  }
  return { state: cur, nowMs: now }
}

describe("resting → walking scheduling", () => {
  it("schedules a rest interval inside the tuning bounds on first step", () => {
    const inp = input({ nowMs: 1000 })
    const next = stepLocomotion(grounded(), inp, 16)
    expect(next.mode).toBe("resting")
    expect(next.restUntilMs).toBeGreaterThanOrEqual(1000 + inp.tuning.restMinMs)
    expect(next.restUntilMs).toBeLessThanOrEqual(1000 + inp.tuning.restMaxMs)
  })

  it("starts a walk once the rest elapses and faces the target", () => {
    const inp = input()
    let s = stepLocomotion(grounded(), inp, 16) // schedule
    const due = s.restUntilMs! + 1
    s = stepLocomotion(s, { ...inp, nowMs: due }, 16)
    expect(s.mode).toBe("walking")
    expect(s.targetX).not.toBeNull()
    expect(s.facing).toBe(s.targetX! < 400 ? "left" : "right")
    expect(s.y).toBe(GROUND)
  })

  it("does not schedule while paused or wander-disabled", () => {
    const base = grounded()
    expect(stepLocomotion(base, input({ paused: true }), 16).restUntilMs).toBeNull()
    expect(stepLocomotion(base, input({ wanderEnabled: false }), 16).restUntilMs).toBeNull()
  })

  it("holds during the rest interval", () => {
    const inp = input()
    const scheduled = stepLocomotion(grounded(), inp, 16)
    const held = stepLocomotion(scheduled, { ...inp, nowMs: scheduled.restUntilMs! - 1 }, 16)
    expect(held).toBe(scheduled)
  })

  it("redraws the rest when the drawn target is too close to walk to", () => {
    // Force the target draw onto the current spot: zero-width walking range.
    const tinyArea: WorkAreaRect = { x: 400, y: 0, width: WIN.width, height: 1040 }
    const inp = input({ workArea: tinyArea })
    const ground = resolveGroundTop(tinyArea, WIN.height)
    let s = createLocomotionState(400, ground)
    s = stepLocomotion(s, inp, 16)
    const due = s.restUntilMs! + 1
    s = stepLocomotion(s, { ...inp, nowMs: due }, 16)
    expect(s.mode).toBe("resting")
    expect(s.restUntilMs).toBeGreaterThan(due)
  })
})

describe("onlyAfterInteraction gate", () => {
  it("defers with a short recheck when no interaction happened", () => {
    const inp = input({ onlyAfterInteraction: true })
    let s = stepLocomotion(grounded(), inp, 16)
    const due = s.restUntilMs! + 1
    s = stepLocomotion(s, { ...inp, nowMs: due }, 16)
    expect(s.mode).toBe("resting")
    expect(s.restUntilMs).toBe(due + RECHECK_DELAY_MS)
  })

  it("defers when the last interaction is stale", () => {
    const inp = input({ onlyAfterInteraction: true, lastInteractionAtMs: 0 })
    let s = stepLocomotion(grounded(), inp, 16)
    const due = Math.max(s.restUntilMs! + 1, INTERACTION_WINDOW_MS + 60_000)
    s = stepLocomotion(s, { ...inp, nowMs: due }, 16)
    expect(s.mode).toBe("resting")
  })

  it("walks when a recent interaction exists", () => {
    const inp = input({ onlyAfterInteraction: true })
    let s = stepLocomotion(grounded(), inp, 16)
    const due = s.restUntilMs! + 1
    s = stepLocomotion(s, { ...inp, nowMs: due, lastInteractionAtMs: due - 1000 }, 16)
    expect(s.mode).toBe("walking")
  })
})

describe("walking", () => {
  function walking(): { state: LocomotionFsmState; inp: LocomotionInput } {
    const inp = input()
    let s = stepLocomotion(grounded(), inp, 16)
    s = stepLocomotion(s, { ...inp, nowMs: s.restUntilMs! + 1 }, 16)
    expect(s.mode).toBe("walking")
    return { state: s, inp }
  }

  it("advances toward the target at the tuned speed and stays on the ground", () => {
    const { state: s, inp } = walking()
    const next = stepLocomotion(s, inp, 1000)
    const moved = Math.abs(next.x - s.x)
    expect(moved).toBeCloseTo(inp.tuning.walkSpeedPxPerSec, 0)
    expect(next.y).toBe(GROUND)
  })

  it("arrives exactly on the target and returns to resting", () => {
    let { state: s } = walking()
    const { inp } = walking()
    const target = s.targetX!
    let now = inp.nowMs
    for (let i = 0; i < 10_000 && s.mode === "walking"; i++) {
      now += 16
      s = stepLocomotion(s, { ...inp, nowMs: now }, 16)
    }
    expect(s.mode).toBe("resting")
    expect(s.x).toBe(target)
    expect(s.targetX).toBeNull()
  })

  it("stops in place when paused mid-walk", () => {
    const { state: s, inp } = walking()
    const stopped = stepLocomotion(s, { ...inp, paused: true }, 16)
    expect(stopped.mode).toBe("resting")
    expect(stopped.x).toBe(s.x)
    expect(stopped.restUntilMs).toBeNull()
  })

  it("stops when wandering is disabled mid-walk", () => {
    const { state: s, inp } = walking()
    const stopped = stepLocomotion(s, { ...inp, wanderEnabled: false }, 16)
    expect(stopped.mode).toBe("resting")
  })
})

describe("falling (drag-throw + off-ground drop)", () => {
  it("beginThrow enters falling with the release velocity and facing", () => {
    const s = beginThrow(grounded(), -500, -200)
    expect(s.mode).toBe("falling")
    expect(s.vx).toBe(-500)
    expect(s.facing).toBe("left")
  })

  it("a thrown pet falls, lands on the ground line, and returns to resting", () => {
    const inp = input({ wanderEnabled: false }) // throw works even with wander off
    let s = beginThrow({ ...grounded(), y: 100 }, 300, 0)
    const result = run(s, inp, 1500, 16)
    s = result.state
    expect(s.mode).toBe("resting")
    expect(s.y).toBe(GROUND)
    expect(s.x).toBeGreaterThan(400)
  })

  it("freezes mid-air while paused", () => {
    const inp = input({ paused: true })
    const s = beginThrow({ ...grounded(), y: 100 }, 0, 0)
    expect(stepLocomotion(s, inp, 16)).toBe(s)
  })

  it("an off-ground resting pet drops to the floor before its next walk", () => {
    const inp = input()
    let s = createLocomotionState(400, 100) // parked mid-screen
    s = stepLocomotion(s, inp, 16) // schedule
    s = stepLocomotion(s, { ...inp, nowMs: s.restUntilMs! + 1 }, 16)
    expect(s.mode).toBe("falling")
    const { state: landed } = run(s, inp, 1500, 16)
    expect(landed.mode).not.toBe("falling")
    expect(landed.y).toBe(GROUND)
  })
})

describe("determinism", () => {
  it("identical seeds and inputs produce identical walks", () => {
    const a = run(grounded(), { ...input(), rng: mulberry32(7) }, 8000, 16)
    const b = run(grounded(), { ...input(), rng: mulberry32(7) }, 8000, 16)
    expect(a.state).toEqual(b.state)
  })
})

describe("window perching (climb / drag-throw)", () => {
  const FULL_PLATFORM: Platform = { x: 0, y: 500, width: 1920 } // top = 212

  function perchedOn(platform: Platform, x: number): LocomotionFsmState {
    return {
      ...createLocomotionState(x, resolvePlatformTop(platform, WIN.height)),
      platform,
    }
  }

  it("drag-throw lands and perches on a window top below the pet", () => {
    const start = { ...createLocomotionState(400, 100) }
    let s = beginThrow(start, 0, 0)
    const inp = input({ platforms: [FULL_PLATFORM] })
    const out = run(s, inp, 600)
    s = out.state
    expect(s.mode).toBe("resting")
    expect(s.platform).not.toBeNull()
    expect(s.y).toBe(resolvePlatformTop(FULL_PLATFORM, WIN.height)) // 212, not the floor
  })

  it("with no platforms a throw still lands on the floor", () => {
    const s = beginThrow({ ...createLocomotionState(400, 100) }, 0, 0)
    const out = run(s, input({ platforms: [] }), 600)
    expect(out.state.y).toBe(GROUND)
    expect(out.state.platform).toBeNull()
  })

  it("a perched pet walks within the platform span", () => {
    const plat: Platform = { x: 600, y: 500, width: 400 } // bounds [600, 712]
    const inp = input({ platforms: [plat] })
    let s = stepLocomotion(perchedOn(plat, 620), inp, 16) // schedule rest
    s = stepLocomotion(s, { ...inp, nowMs: s.restUntilMs! + 1 }, 16) // start walk
    expect(s.mode).toBe("walking")
    expect(s.targetX!).toBeGreaterThanOrEqual(600)
    expect(s.targetX!).toBeLessThanOrEqual(712)
  })

  it("drops off when the perched platform vanishes", () => {
    const plat: Platform = { x: 600, y: 500, width: 400 }
    const s = stepLocomotion(perchedOn(plat, 620), input({ platforms: [] }), 16)
    expect(s.mode).toBe("falling")
    expect(s.platform).toBeNull()
  })

  it("drops off when the perched platform moves", () => {
    const plat: Platform = { x: 600, y: 500, width: 400 }
    const moved: Platform = { x: 800, y: 500, width: 400 }
    const s = stepLocomotion(perchedOn(plat, 620), input({ platforms: [moved] }), 16)
    expect(s.mode).toBe("falling")
  })

  it("falls off when it walks past the platform edge", () => {
    const plat: Platform = { x: 300, y: 500, width: 400 } // span [300, 700]
    // Center at 694 (just inside); a big step pushes the center past 700.
    const walking: LocomotionFsmState = {
      ...perchedOn(plat, 550),
      mode: "walking",
      targetX: 700,
    }
    const s = stepLocomotion(walking, input({ platforms: [plat] }), 200)
    expect(s.mode).toBe("falling")
    expect(s.platform).toBeNull()
  })

  it("climbs onto a hop-reachable platform when enabled", () => {
    // A platform whose top is within HOP_RISE_PX above the floor rest.
    const lowTop = GROUND - 120 // 120px rise (< HOP_RISE_PX)
    const plat: Platform = { x: 0, y: lowTop + WIN.height, width: 1920 }
    const inp = input({ platforms: [plat], climbEnabled: true, rng: () => 0 }) // rng 0 < prob
    let s = stepLocomotion(grounded(400), inp, 16) // schedule rest
    s = stepLocomotion(s, { ...inp, nowMs: s.restUntilMs! + 1 }, 16) // climb decision
    expect(s.mode).toBe("climbing")
    expect(s.platform).toBe(plat)
    // Tween completes after CLIMB_MS.
    const out = run(s, { ...inp, nowMs: s.climbStartMs! }, 40, 16)
    expect(out.state.mode).toBe("resting")
    expect(out.state.y).toBe(lowTop)
  })

  it("never climbs when climbEnabled is false", () => {
    const lowTop = GROUND - 120
    const plat: Platform = { x: 0, y: lowTop + WIN.height, width: 1920 }
    const inp = input({ platforms: [plat], climbEnabled: false, rng: () => 0 })
    let s = stepLocomotion(grounded(400), inp, 16)
    s = stepLocomotion(s, { ...inp, nowMs: s.restUntilMs! + 1 }, 16)
    expect(s.mode).toBe("walking") // ordinary floor wander, no climb
  })
})
