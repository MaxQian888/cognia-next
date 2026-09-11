import { renderHook } from "@testing-library/react"

const sync = jest.fn(async (_ids: readonly string[]) => undefined)
const releaseAll = jest.fn(async () => undefined)
jest.mock("@/lib/power/screen-wake-lock", () => ({
  syncScreenWakeHolders: (ids: readonly string[]) => sync(ids),
  releaseAllScreenWakeHolders: () => releaseAll(),
}))

const rowsRef = { value: [] as Array<{ id: string; powerPolicy?: string }> }
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => rowsRef.value }))
jest.mock("@/lib/db/sessions", () => ({ getSessionsByIds: jest.fn(async () => []) }))

const chatRef = { sessions: {} as Record<string, { status: string }> }
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: (selector: (s: unknown) => unknown) => selector({ sessions: chatRef.sessions }),
}))

const settingsRef = { value: {} as Record<string, unknown> }
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: settingsRef.value }),
}))

import { useSessionPowerGuard } from "./use-session-power-guard"

beforeEach(() => {
  sync.mockClear()
  releaseAll.mockClear()
  rowsRef.value = []
  chatRef.sessions = {}
  settingsRef.value = {}
})

describe("useSessionPowerGuard", () => {
  it("holds the screen for a running conversation that asked for it", () => {
    chatRef.sessions = { s_a: { status: "streaming" }, s_b: { status: "streaming" } }
    rowsRef.value = [
      { id: "s_a", powerPolicy: "keepScreenOn" },
      { id: "s_b", powerPolicy: "allowScreenOff" },
    ]
    renderHook(() => useSessionPowerGuard())
    expect(sync).toHaveBeenLastCalledWith(["s_a"])
  })

  it("holds for the FOCUSED conversation too", () => {
    // The background-only list would have dropped the hold for someone
    // watching one long turn, which is the whole point of the setting.
    chatRef.sessions = { s_a: { status: "awaiting_approval" } }
    rowsRef.value = [{ id: "s_a", powerPolicy: "keepScreenOn" }]
    renderHook(() => useSessionPowerGuard())
    expect(sync).toHaveBeenLastCalledWith(["s_a"])
  })

  it("drops the hold when the turn ends", () => {
    chatRef.sessions = { s_a: { status: "streaming" } }
    rowsRef.value = [{ id: "s_a", powerPolicy: "keepScreenOn" }]
    const { rerender } = renderHook(() => useSessionPowerGuard())
    expect(sync).toHaveBeenLastCalledWith(["s_a"])

    chatRef.sessions = { s_a: { status: "idle" } }
    rerender()
    expect(sync).toHaveBeenLastCalledWith([])
  })

  it("does not re-sync while a turn streams and nothing about the holders changed", () => {
    chatRef.sessions = { s_a: { status: "streaming" } }
    rowsRef.value = [{ id: "s_a", powerPolicy: "keepScreenOn" }]
    const { rerender } = renderHook(() => useSessionPowerGuard())
    sync.mockClear()
    // The chat store publishes a new object per streamed token.
    chatRef.sessions = { s_a: { status: "streaming" } }
    rerender()
    rerender()
    expect(sync).not.toHaveBeenCalled()
  })

  it("applies the app default to a conversation with no opinion", () => {
    chatRef.sessions = { s_a: { status: "streaming" } }
    rowsRef.value = [{ id: "s_a" }]
    settingsRef.value = { sessionPowerPolicy: "keepScreenOn" }
    renderHook(() => useSessionPowerGuard())
    expect(sync).toHaveBeenLastCalledWith(["s_a"])
  })

  it("releases everything on unmount", () => {
    chatRef.sessions = { s_a: { status: "streaming" } }
    rowsRef.value = [{ id: "s_a", powerPolicy: "keepScreenOn" }]
    const { unmount } = renderHook(() => useSessionPowerGuard())
    unmount()
    expect(releaseAll).toHaveBeenCalledTimes(1)
  })
})
