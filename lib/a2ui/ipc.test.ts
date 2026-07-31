/**
 * Tests for the Tauri `a2ui://dispatch` event bridge.
 *
 * Outside Tauri the subscriber is a no-op; inside Tauri each event payload
 * is forwarded to `useA2UIStore.getState().processMessage`. The unlisten
 * function returned by `listen` is propagated unchanged.
 */

const mockProcessMessage = jest.fn()
const mockListen = jest.fn()
let isTauriValue = true

jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: {
    getState: () => ({ processMessage: mockProcessMessage }),
  },
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriValue,
}))

jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

jest.mock("@cognia/logging", () => ({
  loggers: {
    app: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
  },
}))

import { subscribeA2UIDispatch } from "./ipc"

describe("subscribeA2UIDispatch", () => {
  beforeEach(() => {
    mockProcessMessage.mockReset()
    mockListen.mockReset()
    isTauriValue = true
  })

  it("returns a no-op outside Tauri", async () => {
    isTauriValue = false
    const unlisten = await subscribeA2UIDispatch()
    expect(typeof unlisten).toBe("function")
    expect(mockListen).not.toHaveBeenCalled()
    // calling unlisten should not throw
    unlisten()
  })

  it("registers a Tauri listener on the a2ui://dispatch channel", async () => {
    const fakeUnlisten = jest.fn()
    mockListen.mockResolvedValue(fakeUnlisten)

    const unlisten = await subscribeA2UIDispatch()

    expect(mockListen).toHaveBeenCalledTimes(1)
    expect(mockListen.mock.calls[0][0]).toBe("a2ui://dispatch")
    expect(unlisten).toBe(fakeUnlisten)
  })

  it("forwards well-formed envelopes to processMessage", async () => {
    let capturedHandler: ((evt: { payload: unknown }) => void) | null = null
    mockListen.mockImplementation((_channel, handler) => {
      capturedHandler = handler
      return Promise.resolve(() => {})
    })

    await subscribeA2UIDispatch()

    const message = { type: "surfaceReady", surfaceId: "sx" }
    capturedHandler!({
      payload: { type: "a2ui_dispatch", sessionId: "abc", message },
    })

    expect(mockProcessMessage).toHaveBeenCalledWith(message)
  })

  it("ignores payloads with an unexpected shape", async () => {
    let capturedHandler: ((evt: { payload: unknown }) => void) | null = null
    mockListen.mockImplementation((_channel, handler) => {
      capturedHandler = handler
      return Promise.resolve(() => {})
    })

    await subscribeA2UIDispatch()

    capturedHandler!({ payload: null })
    capturedHandler!({ payload: { type: "other", message: { type: "x" } } })
    capturedHandler!({ payload: { type: "a2ui_dispatch" } })

    expect(mockProcessMessage).not.toHaveBeenCalled()
  })

  it("does not throw when processMessage throws", async () => {
    let capturedHandler: ((evt: { payload: unknown }) => void) | null = null
    mockListen.mockImplementation((_channel, handler) => {
      capturedHandler = handler
      return Promise.resolve(() => {})
    })
    mockProcessMessage.mockImplementation(() => {
      throw new Error("nope")
    })

    await subscribeA2UIDispatch()

    expect(() =>
      capturedHandler!({
        payload: {
          type: "a2ui_dispatch",
          message: { type: "surfaceReady", surfaceId: "sx" },
        },
      })
    ).not.toThrow()
  })
})
