import { TauriTransport } from "./transport-tauri"
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

const mockedInvoke = invoke as jest.MockedFunction<typeof invoke>
const mockedListen = listen as jest.MockedFunction<typeof listen>

describe("TauriTransport", () => {
  let transport: TauriTransport

  beforeEach(() => {
    jest.clearAllMocks()
    transport = new TauriTransport()
  })

  describe("call", () => {
    it("delegates to invoke and resolves with its return value", async () => {
      mockedInvoke.mockResolvedValueOnce("hello world")
      await expect(transport.call<string>("greet", { name: "world" })).resolves.toBe("hello world")
      expect(mockedInvoke).toHaveBeenCalledWith("greet", { name: "world" })
    })

    it("forwards undefined args", async () => {
      mockedInvoke.mockResolvedValueOnce(42)
      await expect(transport.call<number>("ping")).resolves.toBe(42)
      expect(mockedInvoke).toHaveBeenCalledWith("ping", undefined)
    })

    it("propagates invoke rejection", async () => {
      mockedInvoke.mockRejectedValueOnce(new Error("rust said no"))
      await expect(transport.call("boom")).rejects.toThrow("rust said no")
    })
  })

  describe("subscribe", () => {
    it("calls listen with the channel name and a payload-extracting handler", async () => {
      const unlistenFn = jest.fn()
      mockedListen.mockResolvedValueOnce(unlistenFn)

      const handler = jest.fn()
      transport.subscribe("test://ch", handler)

      // Allow the listen Promise to resolve.
      await Promise.resolve()

      expect(mockedListen).toHaveBeenCalledWith("test://ch", expect.any(Function))
      // Drive the wrapped Tauri-style event through the handler we passed.
      const wrappedHandler = mockedListen.mock.calls[0][1] as (e: { payload: unknown }) => void
      wrappedHandler({ payload: { foo: 1 } })
      expect(handler).toHaveBeenCalledWith({ foo: 1 })
    })

    it("returns a sync unsubscribe that calls the listen-returned unlisten", async () => {
      const unlistenFn = jest.fn()
      mockedListen.mockResolvedValueOnce(unlistenFn)

      const unsub = transport.subscribe("test://ch", () => {})
      await Promise.resolve()

      unsub()
      expect(unlistenFn).toHaveBeenCalledTimes(1)
    })

    it("runs unlisten exactly once even on repeat unsubscribe", async () => {
      const unlistenFn = jest.fn()
      mockedListen.mockResolvedValueOnce(unlistenFn)

      const unsub = transport.subscribe("test://ch", () => {})
      await Promise.resolve()

      unsub()
      unsub()
      unsub()
      expect(unlistenFn).toHaveBeenCalledTimes(1)
    })

    it("handles unsubscribe called BEFORE the listen Promise resolves", async () => {
      const unlistenFn = jest.fn()
      let resolveListen!: (fn: typeof unlistenFn) => void
      mockedListen.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveListen = resolve
        })
      )

      const unsub = transport.subscribe("test://ch", () => {})
      // Caller cancels before listen resolves.
      unsub()
      // Now listen resolves — the bridge should fire unlisten immediately.
      resolveListen(unlistenFn)
      await Promise.resolve()

      expect(unlistenFn).toHaveBeenCalledTimes(1)
    })

    it("does not surface an unhandled rejection when the Tauri unlisten rejects", async () => {
      // Tauri's injected unlisten throws `listeners[eventId].handlerId` (async),
      // so the returned unlisten resolves to a rejected promise. The unsubscribe
      // must absorb it rather than crash the React tree.
      const onUnhandled = jest.fn()
      process.on("unhandledRejection", onUnhandled)
      try {
        const unlistenFn = jest.fn(() =>
          Promise.reject(new TypeError("listeners[eventId].handlerId"))
        )
        mockedListen.mockResolvedValueOnce(unlistenFn as unknown as () => void)

        const unsub = transport.subscribe("test://ch", () => {})
        await Promise.resolve()

        expect(() => unsub()).not.toThrow()
        expect(unlistenFn).toHaveBeenCalledTimes(1)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(onUnhandled).not.toHaveBeenCalled()
      } finally {
        process.off("unhandledRejection", onUnhandled)
      }
    })

    it("silently absorbs a listen() rejection", async () => {
      mockedListen.mockRejectedValueOnce(new Error("tauri unavailable"))

      const unsub = transport.subscribe("test://ch", () => {})
      await Promise.resolve()
      await Promise.resolve()

      // Subsequent unsubscribe must not throw / call any unlisten.
      expect(() => unsub()).not.toThrow()
    })
  })
})
