import { resolveRuntimeTarget, type RuntimeTargetResolutionInput } from "./runtime-target"

function resolve(overrides: Partial<RuntimeTargetResolutionInput> = {}) {
  return resolveRuntimeTarget({
    platform: "web",
    mobileRuntimeMode: undefined,
    webCompanionConfigured: false,
    ...overrides,
  })
}

describe("resolveRuntimeTarget", () => {
  it("runs an unpaired browser as standalone BYOK", () => {
    expect(resolve()).toEqual({
      id: "web-standalone",
      kind: "standalone",
      platform: "web",
    })
  })

  it("routes a paired browser through its Companion host", () => {
    expect(resolve({ webCompanionConfigured: true })).toEqual({
      id: "web-companion",
      kind: "companion",
      platform: "web",
      hostKind: "cloud",
    })
  })

  it("keeps the two explicit mobile modes distinct", () => {
    expect(resolve({ platform: "mobile", mobileRuntimeMode: "standalone" })).toEqual({
      id: "mobile-standalone",
      kind: "standalone",
      platform: "mobile",
    })
    expect(resolve({ platform: "mobile", mobileRuntimeMode: "paired" })).toEqual({
      id: "mobile-companion",
      kind: "companion",
      platform: "mobile",
      hostKind: "desktop",
    })
  })

  it("does not invent a target before mobile onboarding chooses a mode", () => {
    expect(resolve({ platform: "mobile" })).toBeNull()
  })

  it("leaves Tauri and headless execution on their native local hosts", () => {
    expect(resolve({ platform: "tauri" })).toBeNull()
    expect(resolve({ platform: "headless" })).toBeNull()
  })
})
