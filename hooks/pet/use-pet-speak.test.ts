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

// Hermetic storage + memory mocks: no IndexedDB / vector stack in this test.
const appendPetTurn = jest.fn()
const listRecentPetTurns = jest.fn()
jest.mock("@/lib/db/pet-conversation", () => ({
  appendPetTurn: (...a: unknown[]) => appendPetTurn(...a),
  listRecentPetTurns: (...a: unknown[]) => listRecentPetTurns(...a),
}))
jest.mock("@/lib/memory/runtime/build-deps", () => ({
  tryBuildMemoryDeps: jest.fn().mockResolvedValue(undefined),
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
  level: 3,
} as unknown as PetProfile
const view = {
  effectiveBones: { species: "cat", rarity: "common" },
  mood: "content",
  needs: { energy: 80, mood: 70, bond: 40, lastTickAt: "" },
} as unknown as PetView

function setLlmSpeak(enabled: boolean, petMemory?: { enabled: boolean }) {
  stateRef.current = {
    settings: {
      petSettings: {
        enabled: true,
        anchor: "bottom-right",
        motion: "auto",
        mutedBubbles: false,
        size: 96,
        llmSpeak: { enabled },
        ...(petMemory ? { petMemory } : {}),
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
    // Let the async pipeline (history → recall → speak → record) settle: a
    // macrotask flush drains all chained microtasks.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  __resetPetEventBusForTesting()
  __resetSpeakLimiterForTesting()
  usePetStore.setState({ bubble: null, oneShotQueue: [] })
  complete.mockReset().mockResolvedValue("Hehe, hello friend!")
  buildUtilityLlmClient.mockReset().mockReturnValue({ complete })
  appendPetTurn.mockReset().mockResolvedValue(1)
  listRecentPetTurns.mockReset().mockResolvedValue([])
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

  it("strips a leading emotion tag and plays the mapped one-shot", async () => {
    complete.mockResolvedValue("[love] You are the best!")
    renderHook(() => usePetSpeak({ profile, view, enabled: true }))
    await emitTalk("do you like me?")
    const bubble = usePetStore.getState().bubble
    expect(bubble?.text).toBe("You are the best!")
    expect(bubble?.origin).toBe("llm")
    expect(usePetStore.getState().oneShotQueue).toContain("love")
  })

  it("layers live state + history into the system prompt", async () => {
    listRecentPetTurns.mockResolvedValue([{ at: 1, userText: "hi", reply: "hey!" }])
    renderHook(() => usePetSpeak({ profile, view, enabled: true }))
    await emitTalk("hello")
    const system = complete.mock.calls[0][1].system as string
    expect(system).toContain("mood: content")
    expect(system).toContain("level: 3")
    expect(system).toContain("Recent things you said together:")
    expect(system).toContain("emotion tag in square brackets")
  })

  it("persists the turn when pet memory is on (default)", async () => {
    renderHook(() => usePetSpeak({ profile, view, enabled: true }))
    await emitTalk("remember this chat")
    expect(appendPetTurn).toHaveBeenCalledWith(
      expect.objectContaining({ userText: "remember this chat", reply: "Hehe, hello friend!" })
    )
  })

  it("neither reads nor writes history when pet memory is off", async () => {
    setLlmSpeak(true, { enabled: false })
    renderHook(() => usePetSpeak({ profile, view, enabled: true }))
    await emitTalk("do not remember")
    expect(usePetStore.getState().bubble?.origin).toBe("llm")
    expect(listRecentPetTurns).not.toHaveBeenCalled()
    expect(appendPetTurn).not.toHaveBeenCalled()
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
