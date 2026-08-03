/** @jest-environment jsdom */

import {
  getLiveVoiceFlags,
  isLiveVoiceFlagEnabled,
  isLiveVoiceProviderEnabled,
  LIVE_VOICE_FLAGS,
  LIVE_VOICE_PROVIDER_FLAGS,
  setLiveVoiceFlag,
  subscribeToLiveVoiceFlags,
} from "./feature-flags"
import { LIVE_VOICE_PROVIDER_IDS } from "./types"

const STORAGE_KEY = "cognia-live-voice-flags-v1"
const ENV_KEYS = [
  "NEXT_PUBLIC_LIVE_VOICE_OPENAI",
  "NEXT_PUBLIC_LIVE_VOICE_GOOGLE",
  "NEXT_PUBLIC_LIVE_VOICE_XAI",
  "NEXT_PUBLIC_LIVE_VOICE_QWEN",
  "NEXT_PUBLIC_LIVE_VOICE_DOUBAO",
  "NEXT_PUBLIC_LIVE_VOICE_BAIDU",
] as const

beforeEach(() => {
  window.localStorage.clear()
  for (const key of ENV_KEYS) delete process.env[key]
})

describe("live voice flag defaults", () => {
  it("enables exactly the providers that have a shipped adapter", () => {
    expect(getLiveVoiceFlags()).toEqual({
      liveVoiceOpenai: true,
      liveVoiceGoogle: true,
      liveVoiceXai: true,
      liveVoiceQwen: false,
      liveVoiceDoubao: false,
      liveVoiceBaidu: false,
    })
  })

  it("covers every provider id with exactly one flag", () => {
    // A new provider without a flag would silently bypass the kill switch.
    const flags = LIVE_VOICE_PROVIDER_IDS.map((id) => LIVE_VOICE_PROVIDER_FLAGS[id])
    expect(new Set(flags).size).toBe(LIVE_VOICE_PROVIDER_IDS.length)
    expect(LIVE_VOICE_FLAGS).toEqual(flags)
  })

  it("resolves a provider through its own flag", () => {
    expect(isLiveVoiceProviderEnabled("openai")).toBe(true)
    expect(isLiveVoiceProviderEnabled("doubao")).toBe(false)
  })
})

describe("live voice flag precedence", () => {
  it.each([
    ["1", true],
    ["true", true],
    ["0", false],
    ["false", false],
  ])("reads %s from the environment as %s", (raw, expected) => {
    process.env.NEXT_PUBLIC_LIVE_VOICE_QWEN = raw

    expect(isLiveVoiceFlagEnabled("liveVoiceQwen")).toBe(expected)
  })

  it("ignores an unparseable environment value and keeps the default", () => {
    process.env.NEXT_PUBLIC_LIVE_VOICE_OPENAI = "yes-please"

    expect(isLiveVoiceFlagEnabled("liveVoiceOpenai")).toBe(true)
  })

  it("lets localStorage override the environment", () => {
    process.env.NEXT_PUBLIC_LIVE_VOICE_GOOGLE = "1"
    setLiveVoiceFlag("liveVoiceGoogle", false)

    expect(isLiveVoiceFlagEnabled("liveVoiceGoogle")).toBe(false)
  })

  it("keeps an env-enabled flag on when an unrelated flag is toggled", () => {
    process.env.NEXT_PUBLIC_LIVE_VOICE_QWEN = "1"
    setLiveVoiceFlag("liveVoiceXai", false)

    expect(isLiveVoiceFlagEnabled("liveVoiceQwen")).toBe(true)
    expect(isLiveVoiceFlagEnabled("liveVoiceXai")).toBe(false)
  })

  it("ignores a non-boolean stored value", () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ liveVoiceOpenai: "nope" }))

    expect(isLiveVoiceFlagEnabled("liveVoiceOpenai")).toBe(true)
  })

  it("ignores corrupt stored JSON rather than throwing at import sites", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json")

    expect(isLiveVoiceFlagEnabled("liveVoiceOpenai")).toBe(true)
  })
})

describe("live voice flag subscription", () => {
  it("notifies subscribers on a write", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeToLiveVoiceFlags(listener)

    setLiveVoiceFlag("liveVoiceXai", false)

    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("stops notifying after unsubscribe", () => {
    const listener = jest.fn()
    subscribeToLiveVoiceFlags(listener)()

    setLiveVoiceFlag("liveVoiceXai", false)

    expect(listener).not.toHaveBeenCalled()
  })

  it("still notifies when the write itself fails", () => {
    // Private mode: the toggle must snap back rather than claim success.
    const setItem = jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError")
    })
    const listener = jest.fn()
    const unsubscribe = subscribeToLiveVoiceFlags(listener)

    expect(() => setLiveVoiceFlag("liveVoiceXai", false)).not.toThrow()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(isLiveVoiceFlagEnabled("liveVoiceXai")).toBe(true)

    unsubscribe()
    setItem.mockRestore()
  })
})
