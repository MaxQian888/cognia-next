import { smartContentPreview } from "./smart-preview"

describe("smartContentPreview", () => {
  describe("plain text (no code/JSON)", () => {
    it("returns short text as-is", () => {
      expect(smartContentPreview("Hello world")).toBe("Hello world")
    })

    it("truncates at max with ellipsis", () => {
      const long = "This is a very long message that exceeds the default limit of forty characters."
      const result = smartContentPreview(long, 40)
      expect(result.length).toBeLessThanOrEqual(41) // 40 + trailing char
      expect(result).toContain("…")
    })

    it("extracts first sentence when shorter than max", () => {
      const text = "Fix the login bug. Then we need to add validation for all the form fields."
      expect(smartContentPreview(text, 40)).toBe("Fix the login bug.")
    })

    it("handles Chinese sentence boundaries", () => {
      const text = "修复登录问题。 然后我们需要添加表单验证功能。"
      expect(smartContentPreview(text, 40)).toBe("修复登录问题。")
    })

    it("returns empty for empty/whitespace content", () => {
      expect(smartContentPreview("")).toBe("")
      expect(smartContentPreview("   ")).toBe("")
    })
  })

  describe("leading code fence", () => {
    it("skips a code fence and extracts text after it", () => {
      const content =
        "```typescript\nconst x = 1;\nexport default x;\n```\nPlease review this code."
      expect(smartContentPreview(content, 40)).toBe("Please review this code.")
    })

    it("skips a code fence with language tag", () => {
      const content = "```python\ndef hello():\n    pass\n```\nCheck this function."
      expect(smartContentPreview(content, 40)).toBe("Check this function.")
    })

    it("falls back to raw truncation when code fence is unclosed", () => {
      const content = "```\nconst x = 1;\nconst y = 2;"
      const result = smartContentPreview(content, 20)
      expect(result.length).toBeLessThanOrEqual(21)
    })

    it("handles content that is only a code block", () => {
      const content = "```\nconsole.log('hi')\n```"
      // After skipping fence, remaining is empty → falls back
      const result = smartContentPreview(content, 40)
      expect(result).toBeTruthy()
    })
  })

  describe("leading JSON", () => {
    it("skips a JSON object and extracts text after it", () => {
      const content = '{"type":"object","props":{"name":"str"}} What should I change here?'
      expect(smartContentPreview(content, 40)).toBe("What should I change here?")
    })

    it("skips a JSON array and extracts text after it", () => {
      const content = '["a","b","c"] Help me sort this list.'
      expect(smartContentPreview(content, 40)).toBe("Help me sort this list.")
    })

    it("handles nested JSON objects", () => {
      const content = '{"a":{"b":{"c":1}}} Tell me what this does.'
      expect(smartContentPreview(content, 40)).toBe("Tell me what this does.")
    })

    it("falls back when JSON is too long (over 500 chars)", () => {
      const bigJson = "{" + '"key":"' + "x".repeat(500) + '"}'
      const content = bigJson + " After the JSON."
      const result = smartContentPreview(content, 40)
      // Should fall back to raw truncation since JSON exceeds 500-char scan limit
      expect(result.startsWith("{")).toBe(true)
    })

    it("handles strings with braces inside JSON", () => {
      const content = '{"msg":"hello {world}"} Parse this please.'
      expect(smartContentPreview(content, 40)).toBe("Parse this please.")
    })
  })

  describe("combined code + JSON", () => {
    it("skips code fence then JSON", () => {
      const content = '```json\n{}\n```\n{"extra":true} Now explain.'
      expect(smartContentPreview(content, 40)).toBe("Now explain.")
    })
  })

  describe("SendContent array input", () => {
    it("handles text block arrays", () => {
      const content = [
        { type: "text" as const, text: "Help me with " },
        { type: "text" as const, text: "this bug fix." },
      ]
      expect(smartContentPreview(content, 40)).toBe("Help me with  this bug fix.")
    })

    it("filters non-text blocks", () => {
      const content = [
        { type: "image" as const, url: "http://example.com/img.png" } as unknown,
        { type: "text" as const, text: "What is in this image?" },
      ] as Array<{ type: "text"; text: string }>
      expect(smartContentPreview(content, 40)).toBe("What is in this image?")
    })
  })

  describe("edge cases", () => {
    it("handles text starting with newlines before code", () => {
      const content = "\n\n```js\nfoo()\n```\nExplain this."
      expect(smartContentPreview(content, 40)).toBe("Explain this.")
    })

    it("preserves markdown heading as useful preview", () => {
      const content = "# Setup Guide\nFollow these steps to get started."
      expect(smartContentPreview(content, 40)).toBe("# Setup Guide")
    })

    it("handles custom max length", () => {
      const text = "Short."
      expect(smartContentPreview(text, 100)).toBe("Short.")
    })
  })
})
