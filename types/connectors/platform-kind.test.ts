import { ALL_PLATFORM_KINDS, isPlatformKind, type PlatformKind } from "./platform-kind"

describe("PlatformKind", () => {
  it("enumerates all Phase 1 + Phase 2 + Phase 3 platforms", () => {
    expect(ALL_PLATFORM_KINDS).toEqual([
      "telegram",
      "discord",
      "slack",
      "lark",
      "onebot",
      "dingtalk",
      "wecom",
      "wechat-oa",
      "wechat-personal",
      "qq-official",
      "email",
      "matrix",
      "kook",
      "line",
      "mattermost",
      "github",
    ])
  })

  it("isPlatformKind narrows to the union", () => {
    const x: string = "telegram"
    expect(isPlatformKind(x)).toBe(true)
    if (isPlatformKind(x)) {
      const k: PlatformKind = x
      expect(k).toBe("telegram")
    }
    expect(isPlatformKind("nope")).toBe(false)
  })

  it("returns false for non-string inputs", () => {
    expect(isPlatformKind(123)).toBe(false)
    expect(isPlatformKind(null)).toBe(false)
  })

  it("allows plugin-owned platform ids without treating them as built-ins", () => {
    const pluginPlatform: PlatformKind = "acme-chat"
    expect(pluginPlatform).toBe("acme-chat")
    expect(isPlatformKind(pluginPlatform)).toBe(false)
  })
})
