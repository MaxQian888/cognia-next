import { TAURI_EVENTS, onTauriEvent } from "./events"

jest.mock("@tauri-apps/api/event", () => ({
  listen: jest.fn(),
}))

import { listen } from "@tauri-apps/api/event"

const mockedListen = listen as jest.MockedFunction<typeof listen>

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

describe("lib/tauri/events", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    setTauri(false)
  })

  afterEach(() => {
    setTauri(false)
  })

  describe("TAURI_EVENTS", () => {
    it("exposes the expected channel names", () => {
      expect(TAURI_EVENTS).toEqual({
        trayNewChat: "tray://new-chat",
        traySettings: "tray://settings",
        trayOpenLogs: "tray://open-logs",
        menuOpenLogs: "menu://open-logs",
        menuPrefix: "menu://",
        cliMatches: "cli://matches",
        cliSecondInstance: "cli://second-instance",
        deepLink: "deep-link://received",
      })
    })
  })

  describe("onTauriEvent", () => {
    it("returns an async no-op unlistener outside Tauri", async () => {
      const handler = jest.fn()
      const unlisten = await onTauriEvent("foo", handler)
      expect(typeof unlisten).toBe("function")
      // The fallback returns an async function
      const result = unlisten()
      // Either undefined or a Promise — assert no throw
      await Promise.resolve(result)
      expect(mockedListen).not.toHaveBeenCalled()
    })

    it("forwards payload from native listen and returns unlistener", async () => {
      setTauri(true)
      const unlistenFn = jest.fn()
      mockedListen.mockImplementation(
        async (
          _event: string,
          cb: (e: { payload: unknown; event: string; id: number }) => void
        ) => {
          cb({ event: "foo", id: 1, payload: { hello: "world" } })
          return unlistenFn
        }
      )
      const handler = jest.fn()
      const returned = await onTauriEvent<{ hello: string }>("foo", handler)
      expect(handler).toHaveBeenCalledWith({ hello: "world" })
      expect(returned).toBe(unlistenFn)
      expect(mockedListen).toHaveBeenCalledWith("foo", expect.any(Function))
    })
  })
})
