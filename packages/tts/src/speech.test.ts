import { DEFAULT_SPEECH_LANGUAGE, SPEECH_LANGUAGES, getSpeechLanguage } from "./speech"

describe("speech language catalogue", () => {
  it("ships every documented BCP-47 language", () => {
    const codes = SPEECH_LANGUAGES.map((l) => l.code)
    expect(codes).toContain("en-US")
    expect(codes).toContain("zh-CN")
    expect(codes).toContain("ja-JP")
    expect(codes).toContain("ar-SA")
    // Defaults must point to a real entry.
    expect(codes).toContain(DEFAULT_SPEECH_LANGUAGE)
  })

  it("unique codes only", () => {
    const codes = SPEECH_LANGUAGES.map((l) => l.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it("each row has a name and decorative flag", () => {
    for (const l of SPEECH_LANGUAGES) {
      expect(typeof l.name).toBe("string")
      expect(l.name.length).toBeGreaterThan(0)
      expect(typeof l.flag).toBe("string")
      expect(l.flag.length).toBeGreaterThan(0)
    }
  })
})

describe("getSpeechLanguage", () => {
  it("returns the matching entry by code", () => {
    expect(getSpeechLanguage("zh-CN").code).toBe("zh-CN")
    expect(getSpeechLanguage("ja-JP").name).toBe("日本語")
  })

  it("falls back to the first entry for an unknown code", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(getSpeechLanguage("xx-XX" as any)).toEqual(SPEECH_LANGUAGES[0])
  })

  it("default code resolves to a real language", () => {
    expect(getSpeechLanguage(DEFAULT_SPEECH_LANGUAGE).code).toBe(DEFAULT_SPEECH_LANGUAGE)
  })
})
