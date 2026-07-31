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

  // Regression pins for the execution-order bug (W1): each of these was broken
  // because whitespace was collapsed and symbols were substituted BEFORE the
  // structure was stripped.
  it("strips a markdown heading instead of reading it as 'number'", () => {
    // Was: "number Introduction Hello there." (# → " number " ran before the
    // heading strip, and the collapsed newline killed the /gm anchor).
    expect(normalizeTextForTTS("# Introduction\nHello there.")).toBe("Introduction Hello there.")
  })

  it("removes fenced code blocks instead of reading the code", () => {
    // Was: "Here: js const x equals 1; Done." (inline-code rule ate the ```
    // fences pairwise, exposing the body).
    expect(normalizeTextForTTS("Here:\n```js\nconst x = 1;\n```\nDone.")).toBe("Here: Done.")
  })

  it("strips list markers on every line, not just the first", () => {
    // Was: "Items: - first - second" (collapsed newlines left only index 0 for
    // the /gm anchor to match).
    expect(normalizeTextForTTS("Items:\n- first\n- second")).toBe("Items: first second")
    expect(normalizeTextForTTS("Steps:\n1. one\n2. two")).toBe("Steps: one two")
  })

  it("unwraps bold/italic instead of leaving them as dead rules", () => {
    // The bold/italic rules were dead because * was deleted before they ran.
    expect(normalizeTextForTTS("a **bold** b *em* c")).toBe("a bold b em c")
  })

  it("passes emoji through unchanged (pins current behavior; see W15)", () => {
    // Not fixed here on purpose — this pin makes a future emoji change visible.
    expect(normalizeTextForTTS("Great job 🎉🚀 well done")).toBe("Great job 🎉🚀 well done")
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

  it("routes kanji-bearing Japanese to ja-JP, not zh-CN (W6)", () => {
    // Most Japanese sentences contain kanji; the old han-first check sent them
    // all to Chinese. Kana must win.
    expect(detectLanguage("今日は良い天気ですね")).toBe("ja-JP")
    expect(detectLanguage("私は本を読む")).toBe("ja-JP")
    // Pure-han text stays Chinese.
    expect(detectLanguage("我在读书")).toBe("zh-CN")
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

  it("matches CJK entries as substrings (W15 — \\b never fires around CJK)", () => {
    // Was broken: a Chinese entry never replaced because \b is ASCII-only.
    expect(applyPronunciationDictionary("你好世界", { 你好: "nihao" })).toBe("nihao世界")
    // ASCII still requires a whole-word boundary.
    expect(applyPronunciationDictionary("category", { cat: "feline" })).toBe("category")
  })
})
