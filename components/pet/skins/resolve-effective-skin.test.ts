import {
  resolveEffectiveSkin,
  resolveEffectiveSkinSelection,
  selectionFromEffectiveSkin,
} from "./resolve-effective-skin"

describe("resolveEffectiveSkin", () => {
  it("returns live2d when picked, core ready, and a model exists", () => {
    expect(resolveEffectiveSkin("live2d", { coreReady: true, hasActiveModel: true })).toBe("live2d")
  })

  it("falls back to svg when the skin is svg", () => {
    expect(resolveEffectiveSkin("svg", { coreReady: true, hasActiveModel: true })).toBe("svg")
  })

  it("falls back to svg when the skin is undefined", () => {
    expect(resolveEffectiveSkin(undefined, { coreReady: true, hasActiveModel: true })).toBe("svg")
  })

  it("falls back to svg when core is not ready", () => {
    expect(resolveEffectiveSkin("live2d", { coreReady: false, hasActiveModel: true })).toBe("svg")
  })

  it("falls back to svg when core readiness is still undefined", () => {
    expect(resolveEffectiveSkin("live2d", { coreReady: undefined, hasActiveModel: true })).toBe(
      "svg"
    )
  })

  it("falls back to svg when there is no active model", () => {
    expect(resolveEffectiveSkin("live2d", { coreReady: true, hasActiveModel: false })).toBe("svg")
  })

  it("falls back to svg when compatibility classifies the model invalid", () => {
    expect(
      resolveEffectiveSkin("live2d", {
        coreReady: true,
        hasActiveModel: true,
        modelReady: false,
      })
    ).toBe("svg")
  })

  it("keeps sprite-v2 selected so its boundary can resolve the active pack", () => {
    expect(
      resolveEffectiveSkin("sprite-v2", {
        coreReady: false,
        hasActiveModel: false,
        hasActiveSpritePack: true,
      })
    ).toBe("sprite-v2")
    expect(
      resolveEffectiveSkin("sprite-v2", {
        coreReady: false,
        hasActiveModel: false,
        hasActiveSpritePack: false,
      })
    ).toBe("svg")
    expect(resolveEffectiveSkin("sprite-v2", { coreReady: false, hasActiveModel: false })).toBe(
      "sprite-v2"
    )
  })
})

it("builds a typed effective asset selection", () => {
  expect(selectionFromEffectiveSkin("live2d", { modelId: "m1" })).toEqual({
    skinId: "live2d",
    modelId: "m1",
  })
  expect(selectionFromEffectiveSkin("sprite-v2", { packId: "momo" })).toEqual({
    skinId: "sprite-v2",
    packId: "momo",
  })
  expect(selectionFromEffectiveSkin("live2d", {})).toEqual({ skinId: "svg" })
})

it("preserves an actionable diagnostic for an unknown persisted skin", () => {
  expect(
    resolveEffectiveSkinSelection(
      "removed-skin",
      { coreReady: true, hasActiveModel: false, hasActiveSpritePack: false },
      {}
    )
  ).toEqual({
    requestedSkinId: "removed-skin",
    selection: { skinId: "svg" },
    diagnostics: [expect.objectContaining({ code: "unknownSkin", recoverable: true })],
  })
})
