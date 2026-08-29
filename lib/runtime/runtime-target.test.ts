import {
  isPlaceholderRuntimeTargetId,
  PLACEHOLDER_WEB_COMPANION_TARGET_ID,
  resolveRuntimeTarget,
  type RuntimeTargetResolutionInput,
} from "./runtime-target"

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

describe("placeholder target ids", () => {
  it("flags the Web companion label the resolver invents", () => {
    // `resolveRuntimeTarget` has no way to know which Host a browser talks to,
    // so it names the surface. Anything that routes, resolves a credential or
    // keys persistence has to refuse that name.
    expect(isPlaceholderRuntimeTargetId(PLACEHOLDER_WEB_COMPANION_TARGET_ID)).toBe(true)
    expect(
      isPlaceholderRuntimeTargetId(
        resolveRuntimeTarget({
          platform: "web",
          mobileRuntimeMode: undefined,
          webCompanionConfigured: true,
        })?.id
      )
    ).toBe(true)
  })

  it.each(["web-standalone", "mobile-standalone", "mobile-companion", "local-host", "host-abc"])(
    "leaves %s alone — it names a stored target",
    (id) => {
      expect(isPlaceholderRuntimeTargetId(id)).toBe(false)
    }
  )

  it("treats an absent id as not-a-placeholder rather than throwing", () => {
    expect(isPlaceholderRuntimeTargetId(null)).toBe(false)
    expect(isPlaceholderRuntimeTargetId(undefined)).toBe(false)
  })
})
