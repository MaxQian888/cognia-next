import { LIVE_VOICE_PROVIDER_IDS, isLiveVoiceProviderId } from "./types"

describe("LIVE_VOICE_PROVIDER_IDS", () => {
  it("covers the six first-wave providers", () => {
    expect([...LIVE_VOICE_PROVIDER_IDS]).toEqual([
      "openai",
      "google",
      "xai",
      "qwen",
      "doubao",
      "baidu",
    ])
  })

  it("has no duplicates", () => {
    expect(new Set(LIVE_VOICE_PROVIDER_IDS).size).toBe(LIVE_VOICE_PROVIDER_IDS.length)
  })
})

describe("isLiveVoiceProviderId", () => {
  it.each(LIVE_VOICE_PROVIDER_IDS)("accepts %s", (id) => {
    expect(isLiveVoiceProviderId(id)).toBe(true)
  })

  it("rejects an unknown provider id", () => {
    expect(isLiveVoiceProviderId("anthropic")).toBe(false)
    expect(isLiveVoiceProviderId("")).toBe(false)
  })

  it("rejects a case variant — persisted ids are exact", () => {
    expect(isLiveVoiceProviderId("OpenAI")).toBe(false)
  })

  it("rejects non-string values from untrusted settings or IPC", () => {
    for (const value of [undefined, null, 0, 1, {}, [], ["openai"], Symbol("openai")]) {
      expect(isLiveVoiceProviderId(value)).toBe(false)
    }
  })

  it("rejects inherited Array.prototype members", () => {
    // Guards against a `value in map`-style implementation regression.
    expect(isLiveVoiceProviderId("length")).toBe(false)
    expect(isLiveVoiceProviderId("includes")).toBe(false)
  })
})
