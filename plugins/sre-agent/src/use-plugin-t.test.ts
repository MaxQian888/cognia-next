import { translate } from "./use-plugin-t"

describe("translate", () => {
  it("resolves a key in the active locale", () => {
    expect(translate("zh-CN", "panel.title")).toBe("SRE 事件")
    expect(translate("en", "panel.title")).toBe("SRE incidents")
  })

  it("falls back to English for an unknown locale", () => {
    expect(translate("de", "panel.title")).toBe("SRE incidents")
  })

  it("returns the raw key when nothing defines it, rather than an empty string", () => {
    expect(translate("en", "nope.missing")).toBe("nope.missing")
  })

  it("interpolates every occurrence of a variable", () => {
    expect(translate("en", "lens.records", { count: 12 })).toBe("12 records")
    expect(translate("zh-CN", "list.evidenceCount", { count: 3 })).toBe("已取 3 条")
  })

  it("leaves an unsupplied placeholder visible instead of printing undefined", () => {
    expect(translate("en", "lens.records")).toBe("{count} records")
  })
})
