import { renderHook, act } from "@testing-library/react"
import { usePetSpeak } from "./use-pet-speak"
import { emitPetEvent, __resetPetEventBusForTesting } from "@/lib/pet/events/pet-event-bus"
import { __resetSpeakLimiterForTesting } from "@/lib/pet/bubbles/speak-limiter"
import { usePetStore } from "@/stores/pet/pet-store"
import type { PetProfile } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"
import type { AppSettings } from "@/lib/claude/types"

const complete = jest.fn()
const buildUtilityLlmClient = jest.fn()
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...a: unknown[]) => buildUtilityLlmClient(...a),
}))

const stateRef: { current: { settings: Partial<AppSettings> | null } } = {
  current: { settings: null },
}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) => selector(stateRef.current),
}))

const profile = {
  soul: { name: "Boba", personality: "curious and playful" },
  stage: "adult",
} as unknown as PetProfile
const view = {
  effectiveBones: { species: "cat", rarity: "common" },
} as unknown as PetView

function setLlmSpeak(enabled: boolean) {
  stateRef.current = {
    settings: {
      petSettings: {
        enabled: true,
        anchor: "bottom-right",
        motion: "auto",
        mutedBubbles: false,
        size: 96,
        llmSpeak: { enabled },
      },
    } as Partial<AppSettings>,
  }
}

async function emitTalk(userText?: string) {
  await act(async () => {
    emitPetEvent({
      source: "user",
      kind: "talked",
      meta: userText ? { userText } : undefined,
    })
    // Let the speakAsPet promise chain settle.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  __resetPetEventBusForTesting()
  __resetSpeakLimiterForTesting()
  usePetStore.setState({ bubble: null })
  complete.mockReset().mockResolvedValue("Hehe, hello friend!")
  buildUtilityLlmClient.mockReset().mockReturnValue({ complete })
  setLlmSpeak(true)
})

afterEach(() => {
  // Clear any pending bubble timers.
  usePetStore.setState({ bubble: null })
})

describe("usePetSpeak", () => {
  it("answers typed talk with an LLM bubble", async () => {
    renderHook(() => usePetSpeak({ profile, view, enabled: true }))
    await emitTalk("hello there")
    const bubble = usePetStore.getState().bubble
    expect(bubble?.origin).toBe("llm")
    expect(bubble?.text).toBe("Hehe, hello friend!")
    expect(buildUtilityLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: "pet-speak", session: null })
    )
  })

  it("falls back to a template when LLM speak is disabled", async () => {
    setLlmSpeak(false)
    renderHook(() => usePetSpeak({ profile, view, enabled: true }))
    await emitTalk("hello there")
    const bubble = usePetStore.getState().bubble
    expect(bubble?.origin).toBe("template")
    expect(buildUtilityLlmClient).not.toHaveBeenCalled()
  })

  it("acknowledges bare talk (no text) with a template, never the LLM", async () => {
    renderHook(() => usePetSpeak({ profile, view, enabled: true }))
    await emitTalk()
    expect(usePetStore.getState().bubble?.origin).toBe("template")
    expect(buildUtilityLlmClient).not.toHaveBeenCalled()
  })

  it("rate-limits rapid talk into template fallbacks", async () => {
    renderHook(() => usePetSpeak({ profile, view, enabled: true }))
    await emitTalk("first")
    expect(usePetStore.getState().bubble?.origin).toBe("llm")
    // Immediately again — inside the min interval.
    await emitTalk("second")
    expect(usePetStore.getState().bubble?.origin).toBe("template")
    expect(complete).toHaveBeenCalledTimes(1)
  })

  it("falls back when the model returns nothing", async () => {
    complete.mockResolvedValueOnce("")
    renderHook(() => usePetSpeak({ profile, view, enabled: true }))
    await emitTalk("hello")
    expect(usePetStore.getState().bubble?.origin).toBe("template")
  })

  it("never sends PII text to the model (speakAsPet hard gate)", async () => {
    renderHook(() => usePetSpeak({ profile, view, enabled: true }))
    await emitTalk("my email is alice@example.com please remember it")
    expect(complete).not.toHaveBeenCalled()
    // Still acknowledged, just by template.
    expect(usePetStore.getState().bubble?.origin).toBe("template")
  })

  it("falls back when no client resolves", async () => {
    buildUtilityLlmClient.mockReturnValue(null)
    renderHook(() => usePetSpeak({ profile, view, enabled: true }))
    await emitTalk("hello")
    expect(usePetStore.getState().bubble?.origin).toBe("template")
  })

  it("ignores non-talked events and does nothing when disabled", async () => {
    renderHook(() => usePetSpeak({ profile, view, enabled: true }))
    await act(async () => {
      emitPetEvent({ source: "user", kind: "fed" })
    })
    expect(usePetStore.getState().bubble).toBeNull()

    __resetPetEventBusForTesting()
    renderHook(() => usePetSpeak({ profile, view, enabled: false }))
    await emitTalk("hello")
    expect(usePetStore.getState().bubble).toBeNull()
  })
})
