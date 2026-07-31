/**
 * Character-voice resolver tests (ADR-0030 v2).
 *
 * Pure function — no AppSettings, no orchestrator, no DOM.
 */

import type { Character } from "@cognia/agent-config-types"
import { resolveCharacterVoice } from "./character-voice"

function makeCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: "char_demo",
    name: "Demo",
    avatarColor: "oklch(0.7 0.15 250)",
    systemPrompt: "x",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe("resolveCharacterVoice", () => {
  it("returns undefined when no voiceProfile is set", () => {
    expect(resolveCharacterVoice(makeCharacter())).toBeUndefined()
  })

  it("projects an OpenAI voice profile into the openai overlay slot", () => {
    const overlay = resolveCharacterVoice(
      makeCharacter({
        voiceProfile: { provider: "openai", voiceId: "alloy" },
      })
    )
    expect(overlay).toBeDefined()
    expect(overlay?.ttsProvider).toBe("openai")
    expect(overlay?.openaiVoice).toBe("alloy")
    // Untouched fields stay absent — caller is free to fall through.
    expect("geminiVoice" in (overlay ?? {})).toBe(false)
    expect("ttsRate" in (overlay ?? {})).toBe(false)
  })

  it("overlays rate / pitch / volume only when set", () => {
    const full = resolveCharacterVoice(
      makeCharacter({
        voiceProfile: {
          provider: "edge",
          voiceId: "en-US-JennyNeural",
          rate: 1.2,
          pitch: 0.9,
          volume: 0.5,
        },
      })
    )
    expect(full?.edgeVoice).toBe("en-US-JennyNeural")
    expect(full?.ttsRate).toBe(1.2)
    expect(full?.ttsPitch).toBe(0.9)
    expect(full?.ttsVolume).toBe(0.5)

    const minimal = resolveCharacterVoice(
      makeCharacter({ voiceProfile: { provider: "system", voiceId: "default" } })
    )
    expect(minimal?.systemVoice).toBe("default")
    expect("ttsRate" in (minimal ?? {})).toBe(false)
  })

  it("ignores unknown provider strings (degrades to no overlay)", () => {
    const overlay = resolveCharacterVoice(
      makeCharacter({
        // Force the bad-data path that could only reach runtime if the SDK
        // warn-not-block check let an unknown provider through.
        voiceProfile: {
          provider: "wat" as unknown as "openai",
          voiceId: "alloy",
        },
      })
    )
    expect(overlay).toBeUndefined()
  })

  it("ignores voiceProfile with empty voiceId", () => {
    const overlay = resolveCharacterVoice(
      makeCharacter({
        voiceProfile: { provider: "openai", voiceId: "   " },
      })
    )
    expect(overlay).toBeUndefined()
  })

  it("does not mutate the input character", () => {
    const character = makeCharacter({
      voiceProfile: { provider: "openai", voiceId: "alloy", rate: 1.1 },
    })
    const frozen = Object.freeze({ ...character })
    Object.freeze(frozen.voiceProfile)
    expect(() => resolveCharacterVoice(frozen)).not.toThrow()
    expect(frozen.voiceProfile?.voiceId).toBe("alloy")
  })

  it("covers every TTSProvider in the field map", () => {
    const providers: Array<{ p: string; field: string }> = [
      { p: "system", field: "systemVoice" },
      { p: "openai", field: "openaiVoice" },
      { p: "openai-realtime", field: "realtimeVoice" },
      { p: "gemini", field: "geminiVoice" },
      { p: "edge", field: "edgeVoice" },
      { p: "elevenlabs", field: "elevenlabsVoice" },
      { p: "lmnt", field: "lmntVoice" },
      { p: "hume", field: "humeVoice" },
      { p: "cartesia", field: "cartesiaVoice" },
      { p: "deepgram", field: "deepgramVoice" },
      { p: "xiaomi", field: "xiaomiVoice" },
      { p: "mistral", field: "mistralVoiceId" },
    ]
    for (const { p, field } of providers) {
      const overlay = resolveCharacterVoice(
        makeCharacter({
          voiceProfile: { provider: p as "openai", voiceId: "x" },
        })
      )
      expect(overlay).toBeDefined()
      expect((overlay as Record<string, unknown>)[field]).toBe("x")
      expect(overlay?.ttsProvider).toBe(p)
    }
  })
})
