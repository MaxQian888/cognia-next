import { emotionParamsAt, PARAM_EMOTION_STATES } from "./param-emotion"

describe("emotionParamsAt", () => {
  it("covers exactly the three idle-collapsed AI states", () => {
    expect([...PARAM_EMOTION_STATES].sort()).toEqual(["review", "thinking", "waiting"])
  })

  it("writes head sway + eye scan while thinking", () => {
    const writes = emotionParamsAt("thinking", 500)
    const ids = writes.map((w) => w.id)
    expect(ids).toContain("ParamAngleZ")
    expect(ids).toContain("ParamEyeBallX")
    // Envelope actually moves (nonzero away from phase zero).
    expect(writes.some((w) => Math.abs(w.value) > 0.01)).toBe(true)
  })

  it("bounces while waiting and tilts while reviewing", () => {
    expect(emotionParamsAt("waiting", 300).map((w) => w.id)).toEqual([
      "ParamAngleY",
      "ParamBodyAngleY",
    ])
    expect(emotionParamsAt("review", 700).map((w) => w.id)).toEqual([
      "ParamAngleX",
      "ParamEyeBallX",
    ])
  })

  it("stays within Cubism parameter ranges over a full cycle", () => {
    for (let ms = 0; ms <= 8000; ms += 100) {
      for (const state of ["thinking", "waiting", "review"] as const) {
        for (const w of emotionParamsAt(state, ms)) {
          if (w.id.startsWith("ParamEyeBall")) {
            expect(Math.abs(w.value)).toBeLessThanOrEqual(1)
          } else {
            expect(Math.abs(w.value)).toBeLessThanOrEqual(30)
          }
        }
      }
    }
  })

  it("is deterministic and empty for non-covered states", () => {
    expect(emotionParamsAt("thinking", 1234)).toEqual(emotionParamsAt("thinking", 1234))
    expect(emotionParamsAt("idle", 500)).toEqual([])
    expect(emotionParamsAt("happy", 500)).toEqual([])
  })

  it("starts at rest (zero) at elapsed 0", () => {
    for (const state of ["thinking", "waiting", "review"] as const) {
      for (const w of emotionParamsAt(state, 0)) {
        expect(w.value).toBeCloseTo(0, 5)
      }
    }
  })
})
