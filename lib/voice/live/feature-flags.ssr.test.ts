/**
 * The no-`window` half of the flag module.
 *
 * Runs in the default `node` project (no docblock), where `window` genuinely
 * does not exist — the headless brain and the CLI import this module too, and
 * deleting `window` out of a jsdom global to fake that has bitten this repo
 * before.
 */

import {
  getLiveVoiceFlags,
  isLiveVoiceFlagEnabled,
  setLiveVoiceFlag,
  subscribeToLiveVoiceFlags,
} from "./feature-flags"

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_LIVE_VOICE_QWEN
})

describe("live voice flags without a window", () => {
  it("still resolves defaults", () => {
    expect(getLiveVoiceFlags().liveVoiceOpenai).toBe(true)
    expect(getLiveVoiceFlags().liveVoiceQwen).toBe(false)
  })

  it("still honours the environment layer", () => {
    process.env.NEXT_PUBLIC_LIVE_VOICE_QWEN = "1"

    expect(isLiveVoiceFlagEnabled("liveVoiceQwen")).toBe(true)
  })

  it("no-ops on write instead of throwing", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeToLiveVoiceFlags(listener)

    expect(() => setLiveVoiceFlag("liveVoiceQwen", true)).not.toThrow()
    // No storage layer means nothing changed, so subscribers are not misled
    // into re-reading a value that did not move.
    expect(listener).not.toHaveBeenCalled()
    expect(isLiveVoiceFlagEnabled("liveVoiceQwen")).toBe(false)

    unsubscribe()
  })
})
