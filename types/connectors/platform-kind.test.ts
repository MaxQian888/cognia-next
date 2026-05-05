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
      "qq-official",
      "email",
      "matrix",
      "kook",
      "line",
      "mattermost",
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
})
