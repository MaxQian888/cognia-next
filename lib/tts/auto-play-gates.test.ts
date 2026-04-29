import { canAutoPlayTTS } from "./auto-play-gates"

describe("canAutoPlayTTS", () => {
  it("returns true only when both flags are on and not loading/streaming", () => {
    expect(
      canAutoPlayTTS({
        ttsEnabled: true,
        ttsAutoPlay: true,
        isLoading: false,
        isStreaming: false,
      })
    ).toBe(true)
  })

  it("returns false when ttsEnabled is off", () => {
    expect(
      canAutoPlayTTS({
        ttsEnabled: false,
        ttsAutoPlay: true,
        isLoading: false,
        isStreaming: false,
      })
    ).toBe(false)
  })

  it("returns false when ttsAutoPlay is off", () => {
    expect(
      canAutoPlayTTS({
        ttsEnabled: true,
        ttsAutoPlay: false,
        isLoading: false,
        isStreaming: false,
      })
    ).toBe(false)
  })

  it("returns false during loading", () => {
    expect(
      canAutoPlayTTS({
        ttsEnabled: true,
        ttsAutoPlay: true,
        isLoading: true,
        isStreaming: false,
      })
    ).toBe(false)
  })

  it("returns false during streaming", () => {
    expect(
      canAutoPlayTTS({
        ttsEnabled: true,
        ttsAutoPlay: true,
        isLoading: false,
        isStreaming: true,
      })
    ).toBe(false)
  })
})
