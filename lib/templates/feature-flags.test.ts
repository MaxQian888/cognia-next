import { isUnifiedTemplatePlatformEnabled } from "./feature-flags"

describe("unified template feature flag", () => {
  it("defaults on and supports an explicit legacy fallback", () => {
    expect(isUnifiedTemplatePlatformEnabled(undefined)).toBe(true)
    expect(isUnifiedTemplatePlatformEnabled("1")).toBe(true)
    expect(isUnifiedTemplatePlatformEnabled("0")).toBe(false)
    expect(isUnifiedTemplatePlatformEnabled("false")).toBe(false)
  })
})
