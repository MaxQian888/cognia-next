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

    it("sends a runtime-environment command through the local dispatcher", async () => {
      mockedInvoke.mockResolvedValueOnce({ driver: "e2b" })
      await expect(transport.call("environment_driver_status", {})).resolves.toEqual({
        driver: "e2b",
      })
      expect(mockedInvoke).toHaveBeenCalledWith("environment_local_call", {
        name: "environment_driver_status",
        args: {},
      })
    })

    it("propagates invoke rejection", async () => {
      mockedInvoke.mockRejectedValueOnce(new Error("rust said no"))
      await expect(transport.call("boom")).rejects.toThrow("rust said no")
    })

    it("stamps a distinct IPC identity per automation call without changing its payload", async () => {
      const args = { args: { ctx: { sessionKey: "same-session" }, text: "same action" } }
      mockedInvoke.mockResolvedValue(undefined)
      await transport.call("desktop_type", args)
      await transport.call("desktop_type", args)
      await transport.call("automation_execute", { action: { action: "keys" }, ctx: {} })
      await transport.call("record_start", { args: { recordingId: "one-recording" } })
      await transport.call("record_undo_last")
      const calls = mockedInvoke.mock.calls
      expect(calls[0][1]).toBe(args)
      expect(calls[1][1]).toBe(args)
      const ids = calls.map((call) =>
        new Headers(call[2]?.headers).get("x-cognia-automation-invocation")
      )
      for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/)
      expect(new Set(ids).size).toBe(5)
      expect(args).toEqual({ args: { ctx: { sessionKey: "same-session" }, text: "same action" } })
    })
  })

  describe("subscribe", () => {
    it("keeps readiness pending while an injected native listener registration is delayed", async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const nativeOff = jest.fn()
      const nativeListen = jest.fn().mockResolvedValue(nativeOff)
      mockedListen.mockResolvedValue(jest.fn())
      const delayed: typeof listen = async (...args) => {
        await gate
        return nativeListen(...args)
      }
      const gated = new TauriTransport(delayed)
      const off = gated.subscribe("automation:consent-request", jest.fn())
      expect(nativeListen).not.toHaveBeenCalled()
      expect(mockedListen).not.toHaveBeenCalled()
      let ready = false
      const waiting = gated.whenSubscribed(["automation:consent-request"]).then(() => {
        ready = true
      })
      await Promise.resolve()
      expect(ready).toBe(false)
      release()
      await waiting
      expect(nativeListen).toHaveBeenCalledWith("automation:consent-request", expect.any(Function))
      off()
      expect(nativeOff).toHaveBeenCalledTimes(1)
    })

    it("waits for all registrations of the requested channel without waiting for others", async () => {
      let first!: (off: () => void) => void
      let second!: (off: () => void) => void
      mockedListen.mockReturnValueOnce(
        new Promise((resolve) => {
          first = resolve
        })
      )
      mockedListen.mockReturnValueOnce(
        new Promise((resolve) => {
          second = resolve
        })
      )
      mockedListen.mockReturnValueOnce(new Promise(() => {}))
      transport.subscribe("consent", () => {})
      transport.subscribe("consent", () => {})
      transport.subscribe("other", () => {})
      let ready = false
      const waiting = transport.whenSubscribed(["consent"]).then(() => {
        ready = true
      })
      first(jest.fn())
      await Promise.resolve()
      expect(ready).toBe(false)
      second(jest.fn())
      await waiting
      expect(ready).toBe(true)
    })

    it("bounds an explicit wait without releasing other callers waiting for registration", async () => {
      jest.useFakeTimers()
      try {
        let finish!: (off: () => void) => void
        mockedListen.mockReturnValueOnce(
          new Promise((resolve) => {
            finish = resolve
          })
        )
        transport.subscribe("consent", () => {})
        let registered = false
        const unbounded = transport.whenSubscribed(["consent"]).then(() => {
          registered = true
        })
        const bounded = transport.whenSubscribed(["consent"], 100)
        await jest.advanceTimersByTimeAsync(100)
        await bounded
        expect(registered).toBe(false)
        finish(jest.fn())
        await unbounded
        expect(registered).toBe(true)
      } finally {
        jest.useRealTimers()
      }
    })

    it("does not let a cancelled registration erase a newer wait on the same channel", async () => {
      let first!: (off: () => void) => void
      let second!: (off: () => void) => void
      mockedListen.mockReturnValueOnce(
        new Promise((resolve) => {
          first = resolve
        })
      )
      const off = transport.subscribe("consent", () => {})
      off()
      mockedListen.mockReturnValueOnce(
        new Promise((resolve) => {
          second = resolve
        })
      )
      transport.subscribe("consent", () => {})
      first(jest.fn())
      await Promise.resolve()
      let ready = false
      const waiting = transport.whenSubscribed(["consent"]).then(() => {
        ready = true
      })
      await Promise.resolve()
      expect(ready).toBe(false)
      second(jest.fn())
      await waiting
      expect(ready).toBe(true)
    })
    it("waits for actual registration before declaring the channel ready", async () => {
      let finish!: (off: () => void) => void
      mockedListen.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve
        })
      )
      transport.subscribe("automation:consent-request", () => {})
      let ready = false
      const waiting = transport.whenSubscribed(["automation:consent-request"]).then(() => {
        ready = true
      })
      await Promise.resolve()
      expect(ready).toBe(false)
      finish(jest.fn())
      await waiting
      expect(ready).toBe(true)
    })

    it("releases readiness when an unregistered listener is cancelled", async () => {
      let finish!: (off: () => void) => void
      mockedListen.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve
        })
      )
      const off = transport.subscribe("automation:consent-request", () => {})
      const waiting = transport.whenSubscribed(["automation:consent-request"])
      off()
      await waiting
      const nativeOff = jest.fn()
      finish(nativeOff)
      await Promise.resolve()
      expect(nativeOff).toHaveBeenCalledTimes(1)
    })
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
