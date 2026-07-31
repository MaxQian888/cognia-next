import {
  MAX_MATCHED_TYPES,
  classifySelection,
  type SelectionClassification,
} from "./classify-selection"

const en = { uiLocale: "en-US" }
const zh = { uiLocale: "zh-CN" }

function classify(text: string, options = en): SelectionClassification {
  return classifySelection(text, options)
}

describe("classifySelection", () => {
  it("returns nothing for empty or whitespace-only text", () => {
    expect(classify("").types).toEqual([])
    expect(classify("   \n  ").types).toEqual([])
  })

  describe("url", () => {
    it("matches a whole-text link and normalizes it", () => {
      const result = classify("https://example.com/docs")
      expect(result.types).toContain("url")
      expect(result.url).toBe("https://example.com/docs")
    })

    it("adds a scheme to a bare www host", () => {
      expect(classify("www.example.com").url).toBe("https://www.example.com/")
    })

    it("ignores a link buried in a sentence", () => {
      // Offering "Open link" here would mis-fire on the most destructive
      // contextual action in the set.
      expect(classify("see https://example.com for details").types).not.toContain("url")
    })

    it("refuses every scheme but http and https", () => {
      // First of two gates keeping these away from the OS opener.
      for (const hostile of [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox",
      ]) {
        expect(classify(hostile).types).not.toContain("url")
        expect(classify(hostile).url).toBeUndefined()
      }
    })
  })

  describe("email", () => {
    it("matches a whole-text address", () => {
      const result = classify("someone@example.com")
      expect(result.types).toContain("email")
      expect(result.email).toBe("someone@example.com")
    })

    it("ignores an address inside a sentence", () => {
      expect(classify("mail someone@example.com today").types).not.toContain("email")
    })
  })

  describe("code", () => {
    it("needs at least two signals", () => {
      expect(classify("const x = compute(y);").types).toContain("code")
      expect(classify("function greet() { return 1 }").types).toContain("code")
    })

    it("does not fire on prose that happens to contain one signal", () => {
      expect(classify("The meeting is at noon; bring notes.").types).not.toContain("code")
    })
  })

  describe("measurement", () => {
    it("matches a short value with a unit", () => {
      expect(classify("38°C").types).toContain("measurement")
      expect(classify("12.5 km").types).toContain("measurement")
      expect(classify("$4,000").types).toContain("measurement")
    })

    it("respects the length cap", () => {
      // Without the cap every paragraph mentioning "5 m" would offer a unit
      // conversion.
      const paragraph =
        "The corridor runs about 5 m past the stairwell and then turns sharply left."
      expect(classify(paragraph).types).not.toContain("measurement")
    })
  })

  describe("foreignLanguage", () => {
    it("fires for Han text in an English UI", () => {
      const result = classify("这是一段中文文本", en)
      expect(result.types).toContain("foreignLanguage")
      expect(result.script).toBe("Han")
    })

    it("does not fire for Han text in a Chinese UI", () => {
      expect(classify("这是一段中文文本", zh).types).not.toContain("foreignLanguage")
    })

    it("does not fire when the foreign script is a minority of the letters", () => {
      expect(classify("mostly english text with one 字 in it", en).types).not.toContain(
        "foreignLanguage"
      )
    })

    it("ignores text with no letters at all", () => {
      expect(classify("1234 5678").types).not.toContain("foreignLanguage")
    })
  })

  describe("term", () => {
    it("gates search on a short phrase", () => {
      expect(classify("quantum tunnelling").types).toContain("term")
    })

    it("never co-occurs with a better-matched type", () => {
      expect(classify("https://example.com").types).not.toContain("term")
      expect(classify("someone@example.com").types).not.toContain("term")
      expect(classify("const x = f(y);").types).not.toContain("term")
    })

    it("does not fire for a long or multi-line selection", () => {
      expect(classify("one\ntwo").types).not.toContain("term")
      expect(classify("a ".repeat(40)).types).not.toContain("term")
    })

    it("does not fire for prose", () => {
      // Search is the weakest match in the set and costs a generic action its
      // slot, so a sentence — something to explain or translate — must not
      // claim one.
      expect(classify("The meeting is at noon").types).not.toContain("term")
      expect(classify("we should ship this today").types).not.toContain("term")
      expect(classify("这是一个句子，很长").types).not.toContain("term")
    })
  })

  it("never returns more than the capsule can show", () => {
    // A short foreign-script code snippet can match several detectors at once.
    const result = classify("const 名前 = 计算(值);", en)
    expect(result.types.length).toBeLessThanOrEqual(MAX_MATCHED_TYPES)
  })

  it("is pure — the same input classifies identically every time", () => {
    const once = classify("https://example.com/a")
    const twice = classify("https://example.com/a")
    expect(once).toEqual(twice)
  })
})
