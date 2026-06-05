import {
  BALLISTIC_DEFAULTS,
  SETTLE_SPEED,
  stepBallistic,
  type BallisticParams,
  type BallisticState,
} from "./ballistics"

const PARAMS: BallisticParams = {
  ...BALLISTIC_DEFAULTS,
  groundY: 800,
  minX: 0,
  maxX: 1600,
}

function state(partial: Partial<BallisticState> = {}): BallisticState {
  return { x: 400, y: 200, vx: 0, vy: 0, settled: false, ...partial }
}

/** Run fixed 16ms frames until settled (with a hard cap so a bug can't hang). */
function runToSettle(s: BallisticState, params = PARAMS, maxFrames = 4000): BallisticState {
  let cur = s
  for (let i = 0; i < maxFrames && !cur.settled; i++) {
    cur = stepBallistic(cur, 16, params)
  }
  return cur
}

describe("stepBallistic", () => {
  it("accelerates downward and falls monotonically before impact", () => {
    let s = state()
    const ys: number[] = []
    for (let i = 0; i < 10; i++) {
      s = stepBallistic(s, 16, PARAMS)
      ys.push(s.y)
    }
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThan(ys[i - 1])
    expect(s.vy).toBeGreaterThan(0)
  })

  it("settles exactly on the ground line", () => {
    const s = runToSettle(state())
    expect(s.settled).toBe(true)
    expect(s.y).toBe(PARAMS.groundY)
    expect(s.vx).toBe(0)
    expect(s.vy).toBe(0)
  })

  it("bounces with diminishing energy on an energetic impact", () => {
    // Start just above the ground with high downward speed → first frame impacts.
    let s = state({ y: PARAMS.groundY - 1, vy: 1200 })
    s = stepBallistic(s, 16, PARAMS)
    expect(s.y).toBe(PARAMS.groundY)
    expect(s.vy).toBeLessThan(0) // moving up again
    expect(Math.abs(s.vy)).toBeLessThan(1200) // lost energy
    // And the whole flight still terminates.
    expect(runToSettle(s).settled).toBe(true)
  })

  it("drifts horizontally with the release velocity and decays via friction", () => {
    const settledState = runToSettle(state({ vx: 600 }))
    expect(settledState.x).toBeGreaterThan(400)
    expect(settledState.settled).toBe(true)
  })

  it("bounces off the right wall and reverses", () => {
    let s = state({ x: 1590, vx: 800 })
    s = stepBallistic(s, 16, PARAMS)
    expect(s.x).toBe(PARAMS.maxX)
    expect(s.vx).toBeLessThan(0)
  })

  it("bounces off the left wall and reverses", () => {
    let s = state({ x: 5, vx: -800 })
    s = stepBallistic(s, 16, PARAMS)
    expect(s.x).toBe(PARAMS.minX)
    expect(s.vx).toBeGreaterThan(0)
  })

  it("is inert once settled and for non-positive deltas", () => {
    const done = state({ settled: true })
    expect(stepBallistic(done, 16, PARAMS)).toBe(done)
    const live = state()
    expect(stepBallistic(live, 0, PARAMS)).toBe(live)
    expect(stepBallistic(live, -5, PARAMS)).toBe(live)
  })

  it("clamps huge frame deltas so the window cannot tunnel through the floor", () => {
    let s = state({ y: 100, vy: 0 })
    s = stepBallistic(s, 5000, PARAMS) // one 5s stall frame
    // Clamped to 1/15s of integration: must still be above (or on) the ground.
    expect(s.y).toBeLessThanOrEqual(PARAMS.groundY)
  })

  it("treats a slow ground touch as landing without a bounce", () => {
    let s = state({ y: PARAMS.groundY - 0.5, vy: SETTLE_SPEED / 2 })
    s = stepBallistic(s, 16, PARAMS)
    expect(s.y).toBe(PARAMS.groundY)
    expect(s.vy).toBe(0)
    expect(s.settled).toBe(true)
  })
})
