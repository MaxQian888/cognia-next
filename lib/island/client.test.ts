/** @jest-environment jsdom */
// The cross-window bridge. What matters is that every call is inert outside
// Tauri, that each direction addresses the right window label, and that a
// closed island is a normal outcome rather than an error.

const emitToMock = jest.fn()
const listenMock = jest.fn()
let tauri = false

jest.mock("@tauri-apps/api/event", () => ({
  emitTo: (...a: unknown[]) => emitToMock(...a),
  listen: (...a: unknown[]) => listenMock(...a),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => tauri }))

import {
  ISLAND_ACTION_INTENT_EVENT,
  ISLAND_ACTION_RESULT_EVENT,
  ISLAND_DETAIL_REQUEST_EVENT,
  ISLAND_DETAIL_RESPONSE_EVENT,
  ISLAND_STATE_EVENT,
  ISLAND_STATE_REQUEST_EVENT,
  ISLAND_WINDOW_LABEL,
  MAIN_WINDOW_LABEL,
} from "./events"
import {
  onIslandActionIntent,
  onIslandState,
  requestIslandAction,
  requestIslandDetail,
  requestIslandState,
  sendIslandActionResult,
  sendIslandDetailResponse,
  sendIslandState,
} from "./client"
import { EMPTY_ISLAND_STATE } from "./types"

beforeEach(() => {
  emitToMock.mockReset().mockResolvedValue(undefined)
  listenMock.mockReset().mockResolvedValue(() => {})
  tauri = true
})

describe("outside Tauri", () => {
  beforeEach(() => {
    tauri = false
  })

  it("emits nothing and subscribes to nothing", async () => {
    expect(await sendIslandState(EMPTY_ISLAND_STATE)).toBe(false)
    expect(await requestIslandState()).toBe(false)
    const off = await onIslandState(() => {})
    off()
    expect(emitToMock).not.toHaveBeenCalled()
    expect(listenMock).not.toHaveBeenCalled()
  })
})

describe("main to island", () => {
  it("addresses the island window on all three topics", async () => {
    await sendIslandState(EMPTY_ISLAND_STATE)
    await sendIslandActionResult({ requestId: "r", revision: 1, outcome: "completed" })
    await sendIslandDetailResponse({ requestId: "r", revision: 1, rowId: "x", detail: null })
    expect(emitToMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [ISLAND_WINDOW_LABEL, ISLAND_STATE_EVENT],
      [ISLAND_WINDOW_LABEL, ISLAND_ACTION_RESULT_EVENT],
      [ISLAND_WINDOW_LABEL, ISLAND_DETAIL_RESPONSE_EVENT],
    ])
  })

  it("treats a closed island as a normal outcome, not an error", async () => {
    emitToMock.mockRejectedValue(new Error("window not found"))
    await expect(sendIslandState(EMPTY_ISLAND_STATE)).resolves.toBe(false)
  })
})

describe("island to main", () => {
  it("addresses the main window on all three topics", async () => {
    await requestIslandState()
    await requestIslandAction({ kind: "interrupt", requestId: "r", revision: 1, rowId: "x" })
    await requestIslandDetail({ requestId: "r", revision: 1, rowId: "x" })
    expect(emitToMock.mock.calls.map((call) => [call[0], call[1]])).toEqual([
      [MAIN_WINDOW_LABEL, ISLAND_STATE_REQUEST_EVENT],
      [MAIN_WINDOW_LABEL, ISLAND_ACTION_INTENT_EVENT],
      [MAIN_WINDOW_LABEL, ISLAND_DETAIL_REQUEST_EVENT],
    ])
  })

  it("unwraps the payload for a listener", async () => {
    const handler = jest.fn()
    listenMock.mockImplementation(async (_event: string, cb: (e: { payload: unknown }) => void) => {
      cb({ payload: { kind: "interrupt" } })
      return () => {}
    })
    await onIslandActionIntent(handler)
    expect(handler).toHaveBeenCalledWith({ kind: "interrupt" })
  })

  it("returns a no-op unsubscribe when listening itself fails", async () => {
    listenMock.mockRejectedValue(new Error("nope"))
    const off = await onIslandState(() => {})
    expect(() => off()).not.toThrow()
  })
})
