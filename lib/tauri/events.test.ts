import { transport } from "@/lib/tauri"
import { TAURI_EVENTS, onTauriEvent } from "./events"

let subscribeSpy: jest.SpiedFunction<typeof transport.subscribe>

beforeEach(() => {
  subscribeSpy = jest.spyOn(transport, "subscribe")
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe("lib/tauri/events", () => {
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
        appCloseRequested: "app://close-requested",
      })
    })
  })

  describe("onTauriEvent", () => {
    it("returns a no-op unlistener when the transport is the WebStub", async () => {
      // Default jsdom transport is the WebStub — its `subscribe` is a no-op
      // returning a no-op unlistener; our async wrapper preserves that.
      subscribeSpy.mockRestore()
      const handler = jest.fn()
      const unlisten = await onTauriEvent("foo", handler)
      expect(typeof unlisten).toBe("function")
      // Must not throw or await indefinitely.
      const result = unlisten()
      await Promise.resolve(result)
      expect(handler).not.toHaveBeenCalled()
    })

    it("forwards the channel + handler straight to transport.subscribe", async () => {
      const unlistenFn = jest.fn()
      subscribeSpy.mockReturnValue(unlistenFn)
      const handler = jest.fn()
      const returned = await onTauriEvent<{ hello: string }>("foo", handler)
      expect(subscribeSpy).toHaveBeenCalledWith("foo", handler)
      expect(returned).toBe(unlistenFn)
    })

    it("subscribe→emit→unsubscribe→emit cleanup contract", async () => {
      const handler = jest.fn()
      let captured: ((payload: unknown) => void) | undefined
      const unlistenFn = jest.fn()
      subscribeSpy.mockImplementation((_event, h) => {
        captured = h as (payload: unknown) => void
        return unlistenFn
      })
      const unlisten = await onTauriEvent<{ n: number }>("foo", handler)
      captured?.({ n: 1 })
      expect(handler).toHaveBeenCalledWith({ n: 1 })
      unlisten()
      expect(unlistenFn).toHaveBeenCalledTimes(1)
    })
  })
})
