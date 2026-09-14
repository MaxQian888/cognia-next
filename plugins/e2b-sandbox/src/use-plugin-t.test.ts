import { translate } from "./use-plugin-t"

describe("translate", () => {
  it("resolves a key in the active locale", () => {
    expect(translate("en", "panel.title")).toBe("Sandboxes")
    expect(translate("zh-CN", "panel.title")).toBe("沙箱")
  })

  it("falls back to English for an unknown locale", () => {
    expect(translate("de", "panel.title")).toBe("Sandboxes")
  })

  it("returns the raw key when nothing defines it, rather than an empty string", () => {
    expect(translate("en", "nope.missing")).toBe("nope.missing")
  })

  it("interpolates every occurrence of a variable", () => {
    expect(translate("en", "command.sandbox.live", { count: 3 })).toBe("Live workspaces: 3")
    expect(translate("zh-CN", "command.sandbox.live", { count: 3 })).toBe("活动工作区：3 个")
  })

  it("leaves an unsupplied placeholder visible instead of printing undefined", () => {
    expect(translate("en", "command.sandbox.endpoint")).toBe("Endpoint: {endpoint}")
  })
})
