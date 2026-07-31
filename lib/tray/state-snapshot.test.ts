/** @jest-environment jsdom */
import { renderHook, act } from "@testing-library/react"

// ── Controllable mock state ──────────────────────────────────────────────
let chatState = { status: "idle" as string, activeSessionId: null as string | null }
let liveGoal: { status?: string; safeObjective?: string } | null = null
// `useLiveQuery` is mocked once for both call sites in `useTrayStateSnapshot`
// (the goal query and the pet-profile query); they're told apart by `deps`
// length (goal passes `[activeSessionId]`, pet profile passes `[]`).
let livePetProfile: unknown = undefined
let autostartValue = false
let petSettingsEnabled = false
const listenHandlers: Record<string, (e: { payload?: unknown }) => void> = {}

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/stores/chat", () => ({
  useChatStore: <T>(selector: (s: typeof chatState) => T) => selector(chatState),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T>(selector: (s: { settings: unknown }) => T) =>
    selector({ settings: { petSettings: { enabled: petSettingsEnabled } } }),
}))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (_fn: unknown, deps: unknown[] = []) =>
    deps.length === 0 ? livePetProfile : liveGoal,
}))
jest.mock("@/lib/db/goals", () => ({
  getOpenGoalForSession: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/tauri/autostart", () => ({
  isAutostartEnabled: () => Promise.resolve(autostartValue),
}))
jest.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: { payload?: unknown }) => void) => {
    listenHandlers[event] = handler
    return Promise.resolve(() => {})
  },
}))
// The usage feed hits the subscription transport when enabled — stub it so
// this suite exercises snapshot assembly, not the limits stack (covered by
// `usage.test.ts`). The tray store rides the mocked Tauri prefs.
jest.mock("./usage", () => ({ useTrayUsage: jest.fn(() => null) }))
jest.mock("@/lib/tauri/store", () => ({
  getPref: jest.fn(),
  setPref: jest.fn(() => Promise.resolve()),
}))

import { useTrayStateSnapshot } from "./state-snapshot"
import { broadcastAutostartChanged } from "./autostart-control"
import { useTrayUsage } from "./usage"
import { useTrayStore, __resetTrayStoreForTesting } from "./store"
import { createDefaultProfile } from "@/lib/pet/defaults"

const useTrayUsageMock = useTrayUsage as jest.Mock

beforeEach(() => {
  chatState = { status: "idle", activeSessionId: null }
  liveGoal = null
  livePetProfile = undefined
  autostartValue = false
  petSettingsEnabled = false
  for (const k of Object.keys(listenHandlers)) delete listenHandlers[k]
  // `isMainAppWindow` reads the real Tauri internals; clear any pet label.
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  useTrayUsageMock.mockReturnValue(null)
  __resetTrayStoreForTesting()
})

describe("useTrayStateSnapshot", () => {
  it("reports an idle baseline", () => {
    const { result } = renderHook(() => useTrayStateSnapshot())
    expect(result.current.goal).toEqual({ active: false, paused: false, title: undefined })
    expect(result.current.chat).toEqual({ streaming: false, hasActiveSession: false })
    expect(result.current.app.version).toEqual(expect.any(String))
    expect(result.current.usage).toBeNull()
  })

  it("stamps the store's pinned key onto the usage feed", () => {
    useTrayUsageMock.mockReturnValue({ accounts: [], fetchedAt: 42 })
    useTrayStore.getState().setDisplay({ usageAccountKey: "anthropic:a1" })
    const { result } = renderHook(() => useTrayStateSnapshot())
    expect(result.current.usage).toEqual({
      accounts: [],
      fetchedAt: 42,
      selectedKey: "anthropic:a1",
    })
  })

  it("maps an active goal's redacted objective into the snapshot", () => {
    liveGoal = { status: "active", safeObjective: "ship the tray" }
    chatState = { status: "streaming", activeSessionId: "s1" }
    const { result } = renderHook(() => useTrayStateSnapshot())
    expect(result.current.goal).toEqual({ active: true, paused: false, title: "ship the tray" })
    expect(result.current.chat).toEqual({ streaming: true, hasActiveSession: true })
  })

  it("flags a paused goal", () => {
    liveGoal = { status: "paused", safeObjective: "later" }
    const { result } = renderHook(() => useTrayStateSnapshot())
    expect(result.current.goal.paused).toBe(true)
    expect(result.current.goal.active).toBe(false)
  })

  it("reads OS autostart on mount and updates on broadcast", async () => {
    autostartValue = true
    const { result } = renderHook(() => useTrayStateSnapshot())
    // Allow the mount-time isAutostartEnabled().then to resolve.
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.app.autostart).toBe(true)

    await act(async () => {
      broadcastAutostartChanged(false)
    })
    expect(result.current.app.autostart).toBe(false)
  })

  it("does not read OS autostart in a least-privilege pet window", async () => {
    autostartValue = true
    // A "pet" webview label makes `isMainAppWindow()` false — the pet window
    // isn't granted `autostart:allow-is-enabled`, so the read is skipped.
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
      metadata: { currentWebview: { label: "pet" } },
    }
    const { result } = renderHook(() => useTrayStateSnapshot())
    await act(async () => {
      await Promise.resolve()
    })
    // Stays at the default despite autostartValue=true, proving the effect
    // short-circuited before calling isAutostartEnabled().
    expect(result.current.app.autostart).toBe(false)
  })

  it("reports pet=null when the pet subsystem is disabled, even with a profile present", () => {
    petSettingsEnabled = false
    livePetProfile = createDefaultProfile("acct-1", 0)
    const { result } = renderHook(() => useTrayStateSnapshot())
    expect(result.current.pet).toBeNull()
  })

  it("reports pet=null when enabled but the profile hasn't hatched yet", () => {
    petSettingsEnabled = true
    livePetProfile = undefined
    const { result } = renderHook(() => useTrayStateSnapshot())
    expect(result.current.pet).toBeNull()
  })

  it("reports decayed needs when the pet subsystem is enabled with a profile", () => {
    // Pin wall clock so `lastTickAt` and the `Date.now()` inside `computePetView`
    // are the same instant → zero elapsed → zero decay. Without this the tiny
    // real-time gap between the two occasionally floors a need down by a point,
    // making the assertion flaky. This asserts the wiring reaches
    // `computePetView`, not the decay-rate math (covered by that module's tests).
    const fixedNow = Date.parse("2026-01-01T00:00:00.000Z")
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(fixedNow)
    try {
      petSettingsEnabled = true
      livePetProfile = {
        ...createDefaultProfile("acct-1", 0),
        soul: { name: "Boba", personality: "x", hatchDate: "" },
        stage: "baby",
        needs: { energy: 70, mood: 65, bond: 40, lastTickAt: new Date(fixedNow).toISOString() },
      }
      const { result } = renderHook(() => useTrayStateSnapshot())
      expect(result.current.pet).toEqual({ enabled: true, energy: 70, mood: 65, bond: 40 })
    } finally {
      nowSpy.mockRestore()
    }
  })

  it("marks automation running when an automation event arrives, then clears the kill switch", async () => {
    const { result } = renderHook(() => useTrayStateSnapshot())
    // Wait for the listen() promises to register the handlers.
    await act(async () => {
      await Promise.resolve()
    })
    act(() => listenHandlers["automation:event"]?.({ payload: null }))
    expect(result.current.automation.running).toBe(true)
    expect(result.current.automation.armed).toBe(true)

    act(() => listenHandlers["automation:kill-switch"]?.({ payload: null }))
    expect(result.current.automation).toEqual({ running: false, armed: false })
  })
})
