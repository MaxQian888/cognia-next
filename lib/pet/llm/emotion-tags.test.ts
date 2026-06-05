import {
  EMOTION_TO_ONESHOT,
  EMOTION_VOCAB,
  emotionInstructionLine,
  parseEmotion,
} from "./emotion-tags"

describe("parseEmotion", () => {
  it("parses every vocabulary tag at the leading position", () => {
    for (const tag of EMOTION_VOCAB) {
      expect(parseEmotion(`[${tag}] Hello there!`)).toEqual({
        cleanText: "Hello there!",
        emotion: tag,
      })
    }
  })

  it("is case-insensitive and tolerates inner whitespace", () => {
    expect(parseEmotion("[Happy] Yay!")).toEqual({ cleanText: "Yay!", emotion: "happy" })
    expect(parseEmotion("[ love ] Aww")).toEqual({ cleanText: "Aww", emotion: "love" })
  })

  it("keeps unknown tokens visible instead of swallowing them", () => {
    expect(parseEmotion("[angry] Grr")).toEqual({ cleanText: "[angry] Grr", emotion: null })
    expect(parseEmotion("[totally-not-a-tag-way-too-long] hi").emotion).toBeNull()
  })

  it("ignores mid-sentence brackets", () => {
    expect(parseEmotion("I like [happy] days")).toEqual({
      cleanText: "I like [happy] days",
      emotion: null,
    })
  })

  it("handles no tag, empty input, and a dangling bracket", () => {
    expect(parseEmotion("Just text")).toEqual({ cleanText: "Just text", emotion: null })
    expect(parseEmotion("")).toEqual({ cleanText: "", emotion: null })
    expect(parseEmotion("[")).toEqual({ cleanText: "[", emotion: null })
    expect(parseEmotion("[]")).toEqual({ cleanText: "[]", emotion: null })
  })

  it("maps every vocabulary entry to a one-shot", () => {
    for (const tag of EMOTION_VOCAB) {
      expect(typeof EMOTION_TO_ONESHOT[tag]).toBe("string")
    }
    expect(EMOTION_TO_ONESHOT.excited).toBe("levelUp")
  })
})

describe("emotionInstructionLine", () => {
  it("lists the full vocabulary for the prompt", () => {
    const line = emotionInstructionLine()
    for (const tag of EMOTION_VOCAB) expect(line).toContain(tag)
  })
})
