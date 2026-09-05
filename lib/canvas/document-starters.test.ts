import {
  EMPTY_STARTER_ID,
  allStarters,
  defaultTypeForLanguage,
  findStarter,
  startersForLanguage,
} from "./document-starters"
import enCanvas from "@/i18n/messages/en/canvas.json"
import zhCanvas from "@/i18n/messages/zh-CN/canvas.json"

describe("document starters", () => {
  it("offers starters for the language that was asked for, and only that one", () => {
    const markdown = startersForLanguage("markdown")
    expect(markdown.length).toBeGreaterThan(0)
    expect(markdown.every((starter) => starter.language === "markdown")).toBe(true)
  })

  it("returns an empty list for a language with no starter", () => {
    // The picker still renders the empty choice, so it never becomes a dead
    // control.
    expect(startersForLanguage("bash")).toEqual([])
  })

  it("resolves a starter by id", () => {
    expect(findStarter("markdown-notes")?.language).toBe("markdown")
    expect(findStarter("nope")).toBeUndefined()
  })

  it("never leaves snippet placeholders in the buffer", () => {
    // The editor snippet registry uses `${1:name}` tab stops. A starter is
    // document content, not an insertion, so those must not reach it.
    for (const starter of allStarters()) {
      expect(starter.content).not.toMatch(/\$\{\d/)
    }
  })

  it("gives every starter a non-empty body", () => {
    for (const starter of allStarters()) {
      expect(starter.content.trim().length).toBeGreaterThan(0)
    }
  })

  it("uses unique ids", () => {
    const ids = allStarters().map((starter) => starter.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("types markdown and latex as writing surfaces and the rest as code", () => {
    expect(defaultTypeForLanguage("markdown")).toBe("text")
    expect(defaultTypeForLanguage("latex")).toBe("text")
    expect(defaultTypeForLanguage("python")).toBe("code")
    expect(defaultTypeForLanguage("html")).toBe("code")
  })

  it("has a label in both locales for every starter", () => {
    // `t(`starters.${starter.id}`)` is a dynamic key, which `lint:i18n` cannot
    // see. This is the guard that keeps the picker from rendering key paths.
    const ids = [EMPTY_STARTER_ID, ...allStarters().map((starter) => starter.id)]
    for (const locale of [enCanvas, zhCanvas]) {
      // The split source is the canvas namespace itself, without a `canvas`
      // wrapper. The aggregate adds that wrapper at build time.
      const starters = (
        locale as unknown as {
          newDocumentDialog: { starters: Record<string, string> }
        }
      ).newDocumentDialog.starters
      for (const id of ids) {
        expect(typeof starters[id]).toBe("string")
        expect(starters[id]!.length).toBeGreaterThan(0)
      }
    }
  })
})
