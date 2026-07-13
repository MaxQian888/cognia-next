import {
  applyPronunciationDictionary,
  detectLanguage,
  estimateSpeechDuration,
  generateSSML,
  getWordCount,
  isCJKText,
  normalizeTextForTTS,
  preprocessTextForProvider,
  splitTextForTTS,
} from "./tts-text-utils"

describe("splitTextForTTS", () => {
  it("returns the original text when within the provider limit", () => {
    expect(splitTextForTTS("hi", "openai")).toEqual(["hi"])
  })

  it("splits on sentence boundaries when oversized", () => {
    const text = "Hello world. ".repeat(2000)
    const chunks = splitTextForTTS(text, "openai", 200)
    expect(chunks.length).toBeGreaterThan(1)
    // No chunk should exceed the limit.
    expect(chunks.every((c) => c.length <= 200)).toBe(true)
  })

  it("falls back to word boundaries when no sentence end is in range", () => {
    const text = "alpha beta gamma delta".repeat(50)
    const chunks = splitTextForTTS(text, "openai", 50)
    expect(chunks.length).toBeGreaterThan(1)
  })
})

describe("normalizeTextForTTS", () => {
  it("expands common abbreviations", () => {
    expect(normalizeTextForTTS("Mr. Smith")).toBe("Mister Smith")
    expect(normalizeTextForTTS("Dr. Watson, Prof. Moriarty")).toContain("Doctor")
  })

  it("strips markdown formatting", () => {
    expect(normalizeTextForTTS("**bold** and *italic* and `code`")).toBe("bold and italic and code")
  })

  it("removes URLs", () => {
    expect(normalizeTextForTTS("see https://example.com for details")).toBe("see for details")
  })
})

describe("preprocessTextForProvider", () => {
  it("escapes XML for edge", () => {
    const out = preprocessTextForProvider("<b>x</b>", "edge")
    expect(out).toContain("&lt;")
    expect(out).toContain("&gt;")
    expect(out).not.toContain("<b>")
  })

  it("strips angle brackets for gemini and cartesia", () => {
    expect(preprocessTextForProvider("<x>", "gemini")).not.toContain("<")
    expect(preprocessTextForProvider("<x>", "cartesia")).not.toContain(">")
  })

  it("leaves text alone for openai/elevenlabs/system", () => {
    const out = preprocessTextForProvider("Hello world.", "openai")
    expect(out).toBe("Hello world.")
  })
})

describe("language helpers", () => {
  it("detectLanguage works for common scripts", () => {
    expect(detectLanguage("你好")).toBe("zh-CN")
    expect(detectLanguage("こんにちは")).toBe("ja-JP")
    expect(detectLanguage("안녕")).toBe("ko-KR")
    expect(detectLanguage("hola, ¿que tal?")).toBe("es-ES")
    expect(detectLanguage("hello there")).toBe("en-US")
  })

  it("isCJKText flags CJK-heavy strings", () => {
    expect(isCJKText("你好世界 hello")).toBe(true)
    expect(isCJKText("hello world")).toBe(false)
  })
})

describe("metrics", () => {
  it("getWordCount handles whitespace normally", () => {
    expect(getWordCount("hello world  again")).toBe(3)
    expect(getWordCount("")).toBe(0)
  })

  it("estimateSpeechDuration scales inversely with rate", () => {
    const slow = estimateSpeechDuration("one two three four five", 0.5)
    const fast = estimateSpeechDuration("one two three four five", 2)
    expect(slow).toBeGreaterThan(fast)
  })
})

describe("generateSSML", () => {
  it("wraps text with prosody and optional voice", () => {
    const ssml = generateSSML("hi", { voice: "Aria", rate: 1.2 })
    expect(ssml).toContain("<speak")
    expect(ssml).toContain("Aria")
    expect(ssml).toContain("hi")
    expect(ssml).toContain("rate=")
  })
})

describe("applyPronunciationDictionary", () => {
  it("replaces whole words case-insensitively", () => {
    expect(applyPronunciationDictionary("Hello world", { hello: "hi" })).toBe("hi world")
  })

  it("does not replace partial matches", () => {
    expect(applyPronunciationDictionary("helloWorld", { hello: "hi" })).toBe("helloWorld")
  })

  it("prevents chain replacements", () => {
    expect(applyPronunciationDictionary("hello", { hello: "hi", hi: "hey" })).toBe("hi")
  })

  it("returns the original text when dictionary is empty", () => {
    expect(applyPronunciationDictionary("hello", {})).toBe("hello")
  })

  it("skips empty dictionary keys", () => {
    expect(applyPronunciationDictionary("hello", { "": "x", hello: "hi" })).toBe("hi")
  })

  it("replaces multiple different words", () => {
    expect(applyPronunciationDictionary("hello world", { hello: "hi", world: "earth" })).toBe(
      "hi earth"
    )
  })
})
