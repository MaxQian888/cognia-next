import {
  appTemplates,
  getLocalizedTemplateById,
  getLocalizedTemplatesByCategory,
  getTemplateById,
  getTemplatesByCategory,
  searchLocalizedTemplates,
  searchTemplates,
} from "./index"

describe("A2UI template catalog", () => {
  it("resolves canonical templates and categories", () => {
    expect(appTemplates).toHaveLength(13)
    expect(getTemplateById("calculator")).toMatchObject({ category: "utility" })
    expect(getTemplateById("missing")).toBeUndefined()
    expect(getTemplatesByCategory("form").map(({ id }) => id)).toEqual([
      "survey-form",
      "contact-form",
    ])
  })

  it("searches canonical names, descriptions, and tags case-insensitively", () => {
    expect(searchTemplates("CALCULATOR").map(({ id }) => id)).toContain("calculator")
    expect(searchTemplates("finance").map(({ id }) => id)).toContain("expense-tracker")
    expect(searchTemplates("does-not-exist")).toEqual([])
  })

  it("returns isolated localized templates and searches localized metadata", () => {
    const localized = getLocalizedTemplateById("calculator", "zh-CN")!
    expect(localized.name).toBe("计算器")
    expect(localized).not.toBe(getTemplateById("calculator"))
    expect(getLocalizedTemplateById("missing", "en")).toBeUndefined()
    expect(searchLocalizedTemplates("计算", "zh-CN").map(({ id }) => id)).toContain("calculator")
    expect(searchLocalizedTemplates("  ", "en")).toHaveLength(appTemplates.length)
    expect(getLocalizedTemplatesByCategory("social", "zh-CN")).toEqual([
      expect.objectContaining({ id: "profile-card", name: "个人资料卡" }),
    ])
  })
})
