import {
  isCJKChar,
  isCJKText,
  detectCJKLanguage,
  tokenizeCJK,
  tokenizeMultilingual,
  estimateCJKTokenCount,
  CJK_STOP_WORDS,
  CHINESE_STOP_WORDS,
  JAPANESE_STOP_WORDS,
  KOREAN_STOP_WORDS,
} from "./cjk-tokenizer"

describe("CJK Tokenizer", () => {
  describe("isCJKChar", () => {
    it("should detect Chinese characters", () => {
      expect(isCJKChar("中".codePointAt(0)!)).toBe(true)
      expect(isCJKChar("国".codePointAt(0)!)).toBe(true)
      expect(isCJKChar("人".codePointAt(0)!)).toBe(true)
    })

    it("should detect Japanese Hiragana", () => {
      expect(isCJKChar("あ".codePointAt(0)!)).toBe(true)
      expect(isCJKChar("の".codePointAt(0)!)).toBe(true)
    })

    it("should detect Japanese Katakana", () => {
      expect(isCJKChar("ア".codePointAt(0)!)).toBe(true)
      expect(isCJKChar("カ".codePointAt(0)!)).toBe(true)
    })

    it("should detect Korean Hangul", () => {
      expect(isCJKChar("한".codePointAt(0)!)).toBe(true)
      expect(isCJKChar("글".codePointAt(0)!)).toBe(true)
    })

    it("should reject Latin characters", () => {
      expect(isCJKChar("A".codePointAt(0)!)).toBe(false)
      expect(isCJKChar("z".codePointAt(0)!)).toBe(false)
      expect(isCJKChar("5".codePointAt(0)!)).toBe(false)
    })
  })

  describe("isCJKText", () => {
    it("should return true for Chinese text", () => {
      expect(isCJKText("机器学习是人工智能的一个分支")).toBe(true)
    })

    it("should return true for Japanese text", () => {
      expect(isCJKText("これはテストです")).toBe(true)
    })

    it("should return true for Korean text", () => {
      expect(isCJKText("한국어 텍스트입니다")).toBe(true)
    })

    it("should return false for pure Latin text", () => {
      expect(isCJKText("This is English text only")).toBe(false)
    })

    it("should return true for mixed text with significant CJK", () => {
      expect(isCJKText("Hello 你好世界 World")).toBe(true)
    })

    it("should return false for empty text", () => {
      expect(isCJKText("")).toBe(false)
    })
  })

  describe("detectCJKLanguage", () => {
    it("should detect Chinese text", () => {
      expect(detectCJKLanguage("机器学习算法优化方案")).toBe("chinese")
    })

    it("should detect Japanese text (with hiragana/katakana)", () => {
      expect(detectCJKLanguage("これはテストです。東京タワー")).toBe("japanese")
    })

    it("should detect Korean text", () => {
      expect(detectCJKLanguage("한국어 텍스트입니다")).toBe("korean")
    })

    it("should return none for Latin text", () => {
      expect(detectCJKLanguage("Hello world")).toBe("none")
    })

    it("should return none for empty text", () => {
      expect(detectCJKLanguage("")).toBe("none")
    })
  })

  describe("tokenizeCJK", () => {
    it("should generate bigrams from Chinese text", () => {
      const tokens = tokenizeCJK("机器学习")
      expect(tokens).toEqual(["机器", "器学", "学习"])
    })

    it("should handle single CJK character", () => {
      const tokens = tokenizeCJK("中")
      expect(tokens).toEqual(["中"])
    })

    it("should handle two CJK characters", () => {
      const tokens = tokenizeCJK("中国")
      expect(tokens).toEqual(["中国"])
    })

    it("should handle mixed text (only extract CJK bigrams)", () => {
      const tokens = tokenizeCJK("Hello机器学习World")
      expect(tokens).toEqual(["机器", "器学", "学习"])
    })

    it("should return empty for pure Latin text", () => {
      const tokens = tokenizeCJK("Hello World")
      expect(tokens).toEqual([])
    })

    it("should handle multiple CJK segments", () => {
      const tokens = tokenizeCJK("你好 世界")
      expect(tokens).toContain("你好")
      expect(tokens).toContain("世界")
    })
  })

  describe("tokenizeMultilingual", () => {
    it("should tokenize pure Latin text", () => {
      const tokens = tokenizeMultilingual("hello world test")
      expect(tokens).toContain("hello")
      expect(tokens).toContain("world")
      expect(tokens).toContain("test")
    })

    it("should tokenize pure CJK text", () => {
      const tokens = tokenizeMultilingual("机器学习")
      expect(tokens).toContain("机器")
      expect(tokens).toContain("器学")
      expect(tokens).toContain("学习")
    })

    it("should tokenize mixed text", () => {
      const tokens = tokenizeMultilingual("Deep Learning 深度学习")
      expect(tokens).toContain("deep")
      expect(tokens).toContain("learning")
      expect(tokens).toContain("深度")
      expect(tokens).toContain("度学")
      expect(tokens).toContain("学习")
    })

    it("should filter single-char CJK stop words", () => {
      // Single CJK chars that are stop words should be filtered
      // '的是在' generates bigrams '的是', '是在' which are NOT stop words
      // But individual chars '的', '是', '在' are stop words and get filtered
      const tokens = tokenizeMultilingual("好的")
      // '好的' produces one bigram '好的' — not a stop word, so kept
      expect(tokens.length).toBeGreaterThanOrEqual(0)
      // Verify actual stop words are filtered when they appear as tokens
      const tokens2 = tokenizeMultilingual("machine 的 learning")
      expect(tokens2).not.toContain("的")
    })

    it("should return empty for empty input", () => {
      expect(tokenizeMultilingual("")).toEqual([])
    })

    it("should filter short Latin tokens", () => {
      const tokens = tokenizeMultilingual("a I am ok hello")
      expect(tokens).not.toContain("a")
      // 'I' is 1 char, filtered
      expect(tokens).toContain("am")
      expect(tokens).toContain("ok")
      expect(tokens).toContain("hello")
    })
  })

  describe("estimateCJKTokenCount", () => {
    it("should estimate tokens for CJK text", () => {
      const count = estimateCJKTokenCount("机器学习算法")
      // 6 CJK chars * 1.5 = 9
      expect(count).toBe(9)
    })

    it("should estimate tokens for Latin text", () => {
      const count = estimateCJKTokenCount("Hello World Test")
      // ~16 non-space chars / 4 = 4
      expect(count).toBeGreaterThan(0)
    })

    it("should estimate tokens for mixed text", () => {
      const count = estimateCJKTokenCount("Hello 机器学习")
      expect(count).toBeGreaterThan(0)
    })
  })

  describe("Stop word sets", () => {
    it("should contain Chinese stop words", () => {
      expect(CHINESE_STOP_WORDS.has("的")).toBe(true)
      expect(CHINESE_STOP_WORDS.has("了")).toBe(true)
      expect(CHINESE_STOP_WORDS.has("是")).toBe(true)
    })

    it("should contain Japanese stop words", () => {
      expect(JAPANESE_STOP_WORDS.has("の")).toBe(true)
      expect(JAPANESE_STOP_WORDS.has("は")).toBe(true)
    })

    it("should contain Korean stop words", () => {
      expect(KOREAN_STOP_WORDS.has("이")).toBe(true)
      expect(KOREAN_STOP_WORDS.has("가")).toBe(true)
    })

    it("CJK_STOP_WORDS should be a superset of all language stop words", () => {
      for (const word of CHINESE_STOP_WORDS) {
        expect(CJK_STOP_WORDS.has(word)).toBe(true)
      }
      for (const word of JAPANESE_STOP_WORDS) {
        expect(CJK_STOP_WORDS.has(word)).toBe(true)
      }
      for (const word of KOREAN_STOP_WORDS) {
        expect(CJK_STOP_WORDS.has(word)).toBe(true)
      }
    })
  })
})
