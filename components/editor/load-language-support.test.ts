import { loadLanguageSupport } from "./load-language-support"
import type { EditorLanguage } from "./editor-language"

describe("loadLanguageSupport", () => {
  it.each<EditorLanguage>(["markdown", "typescript", "python", "json", "shell"])(
    "resolves a non-null extension for %s",
    async (language) => {
      const extension = await loadLanguageSupport(language)
      expect(extension).not.toBeNull()
    }
  )

  it("resolves null for plaintext", async () => {
    expect(await loadLanguageSupport("plaintext")).toBeNull()
  })
})
