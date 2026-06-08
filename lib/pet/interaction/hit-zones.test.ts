import { reactionForZone, resolveHitZone, type PetHitZone } from "./hit-zones"

const SIZE = 100 // 1px == 0.01 normalized

describe("resolveHitZone", () => {
  it("classifies the top band as the head", () => {
    expect(resolveHitZone(50, 10, SIZE)).toBe("head")
    expect(resolveHitZone(50, 39, SIZE)).toBe("head")
  })

  it("classifies the lower-right as the tail (facing right)", () => {
    expect(resolveHitZone(80, 70, SIZE)).toBe("tail")
  })

  it("classifies the lower-center as the belly", () => {
    expect(resolveHitZone(50, 70, SIZE)).toBe("belly")
  })

  it("falls back to body for the mid sides", () => {
    expect(resolveHitZone(10, 50, SIZE)).toBe("body")
  })

  it("mirrors X when facing left so the tail stays on the pet's tail side", () => {
    // The same screen point (left side) is the tail when the art is mirrored.
    expect(resolveHitZone(20, 70, SIZE, "left")).toBe("tail")
    // And the right screen-side mirrors to the pet's left → body, not tail.
    expect(resolveHitZone(80, 70, SIZE, "left")).toBe("body")
  })

  it("respects the exact head boundary at 0.40", () => {
    expect(resolveHitZone(50, 40, SIZE)).not.toBe("head") // 0.40 is no longer head
  })

  it("clamps out-of-range / zero-size coordinates gracefully", () => {
    expect(resolveHitZone(-50, -50, SIZE)).toBe("head") // clamped to (0,0) → top
    expect(resolveHitZone(10, 10, 0)).toBe("body") // zero box → centered → body
  })
})

describe("reactionForZone", () => {
  it("maps each zone to a distinct one-shot", () => {
    const map: Record<PetHitZone, string> = {
      head: reactionForZone("head"),
      body: reactionForZone("body"),
      belly: reactionForZone("belly"),
      tail: reactionForZone("tail"),
    }
    expect(map).toEqual({ head: "love", body: "petted", belly: "happy", tail: "surprised" })
  })
})
