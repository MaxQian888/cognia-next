import {
  BUILTIN_DOCUMENT_TEMPLATE_FORMAT,
  BUILTIN_DOCUMENT_TEMPLATE_ICONS,
  BUILTIN_DOCUMENT_TEMPLATE_IDS,
  BUILTIN_DOCUMENT_TEMPLATE_LOCALES,
  builtinDocumentTemplateCopy,
  isBuiltinDocumentTemplateId,
} from "./builtin"

describe("built-in document templates", () => {
  it("ships five, each with an icon and copy in every locale", () => {
    expect(BUILTIN_DOCUMENT_TEMPLATE_IDS).toEqual([
      "guide",
      "todo",
      "project-tracker",
      "weekly-update",
      "meeting-notes",
    ])
    for (const id of BUILTIN_DOCUMENT_TEMPLATE_IDS) {
      expect(BUILTIN_DOCUMENT_TEMPLATE_ICONS[id]).toBeDefined()
      for (const locale of Object.keys(BUILTIN_DOCUMENT_TEMPLATE_LOCALES)) {
        const copy = builtinDocumentTemplateCopy(id, locale)
        expect(copy.name.length).toBeGreaterThan(0)
        expect(copy.description.length).toBeGreaterThan(0)
        expect(copy.content.startsWith("# ")).toBe(true)
        // Bodies are read raw; a brace would still break the ICU validator.
        expect(copy.content).not.toMatch(/[{}]/)
      }
    }
  })

  it("is localized and falls back to English", () => {
    expect(builtinDocumentTemplateCopy("meeting-notes", "zh-CN").name).toBe("会议纪要")
    expect(builtinDocumentTemplateCopy("meeting-notes", "fr").name).toBe("Meeting notes")
  })

  it("is Markdown text and recognises its own ids", () => {
    expect(BUILTIN_DOCUMENT_TEMPLATE_FORMAT).toEqual({ language: "markdown", type: "text" })
    expect(isBuiltinDocumentTemplateId("todo")).toBe(true)
    expect(isBuiltinDocumentTemplateId("dtpl_abc")).toBe(false)
  })
})
