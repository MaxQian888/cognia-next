import { resolveEffectiveSkin } from "./resolve-effective-skin"

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
