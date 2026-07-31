import { IDLE_SIZE, PULL, approach, companionTarget, settled } from "./magnetism"

const RECT = { left: 100, top: 100, width: 200, height: 60 }

describe("companionTarget", () => {
  it("is a small circle on the pointer with nothing to latch onto", () => {
    const frame = companionTarget(40, 80, null)
    expect(frame).toEqual({
      x: 40,
      y: 80,
      width: IDLE_SIZE,
      height: IDLE_SIZE,
      radius: IDLE_SIZE / 2,
    })
  })

  it("takes the target's box, proud of it on every side", () => {
    const frame = companionTarget(200, 130, RECT)
    expect(frame.width).toBe(RECT.width + 10)
    expect(frame.height).toBe(RECT.height + 10)
  })

  it("pulls only partway, so pointer and ring never fully separate", () => {
    // A full pull would make the ring ignore the pointer, which reads as broken
    // rather than as attraction.
    const pointerX = 100
    const centreX = RECT.left + RECT.width / 2
    const frame = companionTarget(pointerX, 130, RECT)
    expect(frame.x).toBeCloseTo(pointerX + (centreX - pointerX) * PULL)
    expect(frame.x).toBeGreaterThan(pointerX)
    expect(frame.x).toBeLessThan(centreX)
  })

  it("ignores a zero-sized target rather than collapsing the ring", () => {
    // A hidden or not-yet-laid-out element measures zero; adopting that box
    // would shrink the ring to a 10px dot with no explanation.
    for (const rect of [
      { left: 0, top: 0, width: 0, height: 40 },
      { left: 0, top: 0, width: 40, height: 0 },
    ]) {
      expect(companionTarget(5, 5, rect).width).toBe(IDLE_SIZE)
    }
  })

  it("adopts the target's corner radius, offset to stay concentric", () => {
    expect(companionTarget(200, 130, RECT, 8).radius).toBe(13)
  })

  it("stays square for a square target rather than inventing a radius", () => {
    expect(companionTarget(200, 130, RECT, 0).radius).toBe(0)
    expect(companionTarget(200, 130, RECT).radius).toBe(0)
  })
})

describe("approach", () => {
  const FROM = { x: 0, y: 0, width: 10, height: 10, radius: 5 }
  const TO = { x: 100, y: 50, width: 30, height: 20, radius: 15 }

  it("moves a fraction of the remaining distance on every axis", () => {
    const next = approach(FROM, TO, 0.5)
    expect(next).toEqual({ x: 50, y: 25, width: 20, height: 15, radius: 10 })
  })

  it("clamps the easing rather than overshooting or reversing", () => {
    expect(approach(FROM, TO, 5)).toEqual(TO)
    expect(approach(FROM, TO, -1)).toEqual(FROM)
  })

  it("converges rather than oscillating", () => {
    let current = FROM
    for (let i = 0; i < 200; i += 1) current = approach(current, TO, 0.18)
    expect(settled(current, TO)).toBe(true)
  })
})

describe("settled", () => {
  const A = { x: 0, y: 0, width: 10, height: 10, radius: 5 }

  it("is true only when every axis has caught up", () => {
    expect(settled(A, { ...A })).toBe(true)
    expect(settled(A, { ...A, x: 5 })).toBe(false)
    expect(settled(A, { ...A, radius: 5.5 })).toBe(false)
  })

  it("tolerates a sub-pixel difference no frame could show", () => {
    expect(settled(A, { ...A, x: 0.01 })).toBe(true)
  })
})
