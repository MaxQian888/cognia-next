import { renderHook, act } from "@testing-library/react"
import { usePetProactive } from "./use-pet-proactive"
import { emitPetEvent, __resetPetEventBusForTesting } from "@/lib/pet/events/pet-event-bus"
import { __resetSpeakLimiterForTesting } from "@/lib/pet/bubbles/speak-limiter"
import { __resetProactiveClaims, isClaimed } from "@/lib/pet/llm/proactive/claim-registry"
import {
  __resetActivitySignalForTesting,
  markActivity,
} from "@/lib/pet/llm/proactive/activity-signal"
import { usePetStore } from "@/stores/pet/pet-store"
import type { PetProfile, ProactiveState } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"
import type { AppSettings } from "@/lib/claude/types"

const complete = jest.fn()
const buildUtilityLlmClient = jest.fn()
jest.mock("@/lib/ai/generation/utility-client", () => ({
  buildUtilityLlmClient: (...a: unknown[]) => buildUtilityLlmClient(...a),
}))

const patchPetProfile = jest.fn()
jest.mock("@/lib/db/pet", () => ({
  patchPetProfile: (...a: unknown[]) => patchPetProfile(...a),
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

function profileWith(proactiveState?: ProactiveState): PetProfile {
  return {
    soul: { name: "Boba", personality: "curious" },
    stage: "adult",
    level: 4,
    proactiveState,
  } as unknown as PetProfile
}

const view = {
  effectiveBones: { species: "cat", rarity: "common" },
  mood: "content",
  needs: { energy: 80, mood: 70, bond: 60, lastTickAt: "" },
  // Wisdom 100 keeps the workflowRun comment gate wide open — these tests
  // exercise the utterance pipeline, not the gate (covered in triggers.test).
  effectiveStats: { debugging: 0, patience: 0, chaos: 0, wisdom: 100, snark: 0 },
} as unknown as PetView

interface SettingsOverrides {
  proactiveEnabled?: boolean
  eventComments?: boolean
  idleChatter?: boolean
  timeGreetings?: boolean
  quietHours?: { enabled: boolean; start: string; end: string }
}

function setSettings(over: SettingsOverrides = {}) {
  stateRef.current = {
    settings: {
      petSettings: {
        enabled: true,
        anchor: "bottom-right",
        motion: "auto",
        mutedBubbles: false,
        size: 96,
        llmSpeak: { enabled: true },
        proactive: {
          enabled: over.proactiveEnabled ?? true,
          tier: "normal",
          eventComments: over.eventComments ?? true,
          idleChatter: over.idleChatter ?? true,
          timeGreetings: over.timeGreetings ?? true,
        },
      },
      ...(over.quietHours ? { notificationPreferences: { quietHours: over.quietHours } } : {}),
    } as Partial<AppSettings>,
  }
}

/** Local 14:00 — outside both greeting windows. */
const AFTERNOON = new Date(2026, 5, 5, 14, 0, 0)
/** Local 08:00 — inside the morning greeting window. */
const MORNING = new Date(2026, 5, 5, 8, 0, 0)

async function flush() {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(0)
    await jest.advanceTimersByTimeAsync(0)
  })
}

async function emitEvent(kind: "levelUp" | "workflowRun") {
  await act(async () => {
    emitPetEvent({ source: "system", kind, at: Date.now() })
  })
  await flush()
}

async function tick() {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(60_000)
  })
  await flush()
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(AFTERNOON)
  __resetPetEventBusForTesting()
  __resetSpeakLimiterForTesting()
  __resetProactiveClaims()
  __resetActivitySignalForTesting()
  usePetStore.setState({ bubble: null, oneShotQueue: [] })
  complete.mockReset().mockResolvedValue("[happy] Woohoo, level up!")
  buildUtilityLlmClient.mockReset().mockReturnValue({ complete })
  patchPetProfile.mockReset().mockResolvedValue(undefined)
  setSettings()
})

afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
  __resetProactiveClaims()
  __resetActivitySignalForTesting()
})

function mount(profile = profileWith()) {
  return renderHook(() => usePetProactive({ profile, view, enabled: true }))
}

describe("usePetProactive — claims", () => {
  it("claims milestone kinds while enabled and releases on unmount", () => {
    const { unmount } = mount()
    expect(isClaimed("levelUp")).toBe(true)
    expect(isClaimed("achievementUnlocked")).toBe(true)
    expect(isClaimed("success")).toBe(false) // radar kinds never claimed
    unmount()
    expect(isClaimed("levelUp")).toBe(false)
  })

  it("claims nothing when proactive is disabled (default-off invariant)", () => {
    setSettings({ proactiveEnabled: false })
    mount()
    expect(isClaimed("levelUp")).toBe(false)
  })
})

describe("usePetProactive — event comments", () => {
  it("answers a claimed event with an LLM bubble and plays the emotion", async () => {
    mount()
    await emitEvent("levelUp")
    const bubble = usePetStore.getState().bubble
    expect(bubble?.origin).toBe("llm")
    expect(bubble?.text).toBe("Woohoo, level up!")
    expect(usePetStore.getState().oneShotQueue).toContain("happy")
    expect(buildUtilityLlmClient).toHaveBeenCalledWith(
      expect.objectContaining({ featureId: "pet-proactive" })
    )
    // Counters persisted (skip-memory: only proactiveState, never history).
    expect(patchPetProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        proactiveState: expect.objectContaining({ spokenToday: 1 }),
      })
    )
  })

  it("falls back to the template when the model fails (claimed kind)", async () => {
    complete.mockRejectedValue(new Error("boom"))
    mount()
    await emitEvent("levelUp")
    expect(usePetStore.getState().bubble?.origin).toBe("template")
  })

  it("falls back to the template when the gate blocks (min gap)", async () => {
    mount(
      profileWith({
        lastSpokeAtMs: Date.now() - 1000,
        dayKey: "2026-06-05",
        spokenToday: 1,
        greetedWindows: [],
      })
    )
    await emitEvent("levelUp")
    expect(usePetStore.getState().bubble?.origin).toBe("template")
    expect(complete).not.toHaveBeenCalled()
  })

  it("stays silent on a claimed kind without a template (workflowRun + failure)", async () => {
    complete.mockRejectedValue(new Error("boom"))
    mount()
    await emitEvent("workflowRun")
    expect(usePetStore.getState().bubble).toBeNull()
  })

  it("respects DND quiet hours (template fallback, no LLM call)", async () => {
    setSettings({ quietHours: { enabled: true, start: "00:00", end: "23:59" } })
    mount()
    await emitEvent("levelUp")
    expect(complete).not.toHaveBeenCalled()
    expect(usePetStore.getState().bubble?.origin).toBe("template")
  })
})

describe("usePetProactive — idle chatter", () => {
  it("speaks after the idle threshold and stays silent on failure", async () => {
    markActivity(Date.now() - 13 * 60_000) // past the normal tier's 12 min
    mount()
    await tick()
    expect(usePetStore.getState().bubble?.origin).toBe("llm")

    // Failure path → silence (no template for idle chatter).
    usePetStore.setState({ bubble: null })
    __resetSpeakLimiterForTesting()
    complete.mockRejectedValue(new Error("boom"))
    patchPetProfile.mockClear()
    await tick()
    expect(usePetStore.getState().bubble).toBeNull()
  })

  it("does not speak while the user is active", async () => {
    markActivity(Date.now() - 60_000) // active a minute ago
    mount()
    await tick()
    expect(usePetStore.getState().bubble).toBeNull()
    expect(complete).not.toHaveBeenCalled()
  })
})

describe("usePetProactive — time greetings", () => {
  it("greets once in the morning window and records the window key", async () => {
    jest.setSystemTime(MORNING)
    complete.mockResolvedValue("Good morning, sunshine!")
    mount()
    await tick()
    expect(usePetStore.getState().bubble?.text).toBe("Good morning, sunshine!")
    expect(patchPetProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        proactiveState: expect.objectContaining({
          greetedWindows: expect.arrayContaining([expect.stringContaining(":morning")]),
        }),
      })
    )
  })

  it("never repeats a greeting window already used today", async () => {
    jest.setSystemTime(MORNING)
    const dayKey = "2026-06-05"
    mount(
      profileWith({
        lastSpokeAtMs: null,
        dayKey,
        spokenToday: 1,
        greetedWindows: [`${dayKey}:morning`],
      })
    )
    await tick()
    expect(usePetStore.getState().bubble).toBeNull()
    expect(complete).not.toHaveBeenCalled()
  })
})
