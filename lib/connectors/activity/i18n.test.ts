import { resolveActivityI18n } from "./i18n"

describe("resolveActivityI18n", () => {
  it("returns English for en", () => {
    const i18n = resolveActivityI18n("en")
    expect(i18n.working).toBe("Working")
    expect(i18n.done).toBe("Done")
    expect(i18n.tools(3)).toBe("3 tools")
    expect(i18n.tools(1)).toBe("1 tool")
    expect(i18n.edits(2)).toBe("2 edits")
    expect(i18n.elapsed(45)).toBe("45s")
  })

  it("returns Chinese for zh-CN", () => {
    const i18n = resolveActivityI18n("zh-CN")
    expect(i18n.working).toBe("处理中")
    expect(i18n.done).toBe("完成")
    expect(i18n.tools(3)).toBe("3 工具")
    expect(i18n.edits(1)).toBe("1 处编辑")
    expect(i18n.currentTool("bash")).toBe("当前：bash")
  })

  it("accepts zh / zh-Hans aliases", () => {
    expect(resolveActivityI18n("zh").working).toBe("处理中")
    expect(resolveActivityI18n("zh-Hans").working).toBe("处理中")
  })

  it("accepts en-US alias", () => {
    expect(resolveActivityI18n("en-US").working).toBe("Working")
  })

  it("falls back to English for an unknown locale", () => {
    expect(resolveActivityI18n("fr-FR").working).toBe("Working")
  })

  it("falls back to English for null/undefined", () => {
    expect(resolveActivityI18n(undefined).working).toBe("Working")
    expect(resolveActivityI18n(null).working).toBe("Working")
  })

  it("fileEdited interpolates path and counts", () => {
    expect(resolveActivityI18n("en").fileEdited("lib/x.ts", 12, 3)).toBe("lib/x.ts (+12 −3)")
    expect(resolveActivityI18n("zh-CN").fileEdited("lib/x.ts", 12, 3)).toBe("lib/x.ts（+12 −3）")
  })

  it("diffSkipped is defined for both locales", () => {
    expect(resolveActivityI18n("en").diffSkipped.length).toBeGreaterThan(0)
    expect(resolveActivityI18n("zh-CN").diffSkipped.length).toBeGreaterThan(0)
  })

  it("fileCreated / diffTruncated / diffExpandHint are defined for both locales", () => {
    for (const loc of ["en", "zh-CN"] as const) {
      const i18n = resolveActivityI18n(loc)
      expect(i18n.fileCreated("new.ts", 5).length).toBeGreaterThan(0)
      expect(i18n.diffTruncated(3).length).toBeGreaterThan(0)
      expect(i18n.diffExpandHint.length).toBeGreaterThan(0)
    }
  })

  it("appendLine / appendFinal render for both locales (append mode)", () => {
    for (const loc of ["en", "zh-CN"] as const) {
      const i18n = resolveActivityI18n(loc)
      expect(i18n.appendLine(2, 5, "bash").length).toBeGreaterThan(0)
      expect(i18n.appendLine(1, 1, null)).not.toContain("·")
      expect(i18n.appendFinal("done", 10).length).toBeGreaterThan(0)
      expect(i18n.appendFinal("failed", 10).length).toBeGreaterThan(0)
    }
  })
})
