import {
  PET_SKIN_CAPABILITIES,
  normalizePetSkinSelection,
  quantizeSpriteLookDirection,
  resolvePetBehaviorLayer,
} from "./skin-governance"

describe("pet skin governance", () => {
  it("normalizes unknown and incomplete selections to SVG with an actionable diagnostic", () => {
    expect(normalizePetSkinSelection("removed-skin", {})).toEqual({
      requestedSkinId: "removed-skin",
      selection: { skinId: "svg" },
      diagnostics: [
        expect.objectContaining({ code: "unknownSkin", severity: "error", recoverable: true }),
      ],
    })
    expect(normalizePetSkinSelection("live2d", {})).toEqual(
      expect.objectContaining({
        selection: { skinId: "svg" },
        diagnostics: [expect.objectContaining({ code: "assetMissing" })],
      })
    )
  })

  it("publishes an explicit capability matrix for all three families", () => {
    expect(Object.keys(PET_SKIN_CAPABILITIES)).toEqual(["svg", "live2d", "sprite-v2"])
    expect(PET_SKIN_CAPABILITIES.live2d).toMatchObject({ gaze: true, lowPower: true })
    expect(PET_SKIN_CAPABILITIES["sprite-v2"]).toMatchObject({ gaze: true, facing: true })
  })

  it("applies the shared precedence policy", () => {
    expect(resolvePetBehaviorLayer({ suspended: true, held: true, oneShot: true })).toBe(
      "suspended"
    )
    expect(resolvePetBehaviorLayer({ held: true, oneShot: true, locomotion: true })).toBe("held")
    expect(resolvePetBehaviorLayer({ oneShot: true, locomotion: true })).toBe("oneShot")
    expect(resolvePetBehaviorLayer({ locomotion: true, semanticState: true })).toBe("locomotion")
    expect(resolvePetBehaviorLayer({ semanticState: true, gaze: true })).toBe("semanticState")
    expect(resolvePetBehaviorLayer({ gaze: true })).toBe("gaze")
  })

  it("maps gaze clockwise into the 16 cells in rows 9 and 10", () => {
    expect(quantizeSpriteLookDirection({ x: 0, y: -1 })).toEqual({ row: 9, frame: 0, index: 0 })
    expect(quantizeSpriteLookDirection({ x: 1, y: 0 })).toEqual({ row: 9, frame: 4, index: 4 })
    expect(quantizeSpriteLookDirection({ x: 0, y: 1 })).toEqual({ row: 10, frame: 0, index: 8 })
    expect(quantizeSpriteLookDirection({ x: -1, y: 0 })).toEqual({ row: 10, frame: 4, index: 12 })
    expect(quantizeSpriteLookDirection({ x: 0.05, y: 0.05 })).toBeNull()
  })

  it("uses hysteresis and rejects stale pointer samples", () => {
    const now = 10_000
    expect(
      quantizeSpriteLookDirection(
        { x: 0.7, y: -0.7, updatedAt: now - 2_001 },
        { now, previousIndex: 2 }
      )
    ).toBeNull()
    expect(
      quantizeSpriteLookDirection({ x: 0.41, y: -0.91, updatedAt: now }, { now, previousIndex: 1 })
    ).toEqual({ row: 9, frame: 1, index: 1 })
  })
})
