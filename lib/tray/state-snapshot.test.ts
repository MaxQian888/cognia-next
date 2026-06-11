import { renderHook, act } from "@testing-library/react"

// ── Controllable mock state ──────────────────────────────────────────────
let chatState = { status: "idle" as string, activeSessionId: null as string | null }
let liveGoal: { status?: string; safeObjective?: string } | null = null
let autostartValue = false
const listenHandlers: Record<string, (e: { payload?: unknown }) => void> = {}

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("@/stores/chat", () => ({
  useChatStore: <T>(selector: (s: typeof chatState) => T) => selector(chatState),
}))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => liveGoal,
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

import { useTrayStateSnapshot } from "./state-snapshot"
import { broadcastAutostartChanged } from "./autostart-control"

beforeEach(() => {
  chatState = { status: "idle", activeSessionId: null }
  liveGoal = null
  autostartValue = false
  for (const k of Object.keys(listenHandlers)) delete listenHandlers[k]
})

describe("useTrayStateSnapshot", () => {
  it("reports an idle baseline", () => {
    const { result } = renderHook(() => useTrayStateSnapshot())
    expect(result.current.goal).toEqual({ active: false, paused: false, title: undefined })
    expect(result.current.chat).toEqual({ streaming: false, hasActiveSession: false })
    expect(result.current.app.version).toEqual(expect.any(String))
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
