import { WebStubTransport } from "./transport-web"

describe("WebStubTransport", () => {
  let transport: WebStubTransport

  beforeEach(() => {
    transport = new WebStubTransport()
  })

  describe("call", () => {
    it("rejects with a clear web-mode error containing the command name", async () => {
      await expect(transport.call("greet")).rejects.toThrow(
        "tauri-only command from web mode: greet"
      )
    })

    it("includes the command name verbatim — even with snake_case", async () => {
      await expect(transport.call("foo_bar_baz")).rejects.toThrow(
        "tauri-only command from web mode: foo_bar_baz"
      )
    })

    it("ignores args silently and still rejects", async () => {
      await expect(transport.call("any_cmd", { foo: 1, bar: "two" })).rejects.toThrow(
        "tauri-only command from web mode: any_cmd"
      )
    })

    it("returns a Promise (never throws synchronously)", () => {
      const result = transport.call("some_cmd")
      expect(result).toBeInstanceOf(Promise)
      // Swallow the rejection so it doesn't surface as an unhandled promise.
      result.catch(() => {})
    })
  })

  describe("subscribe", () => {
    it("returns a no-op unsubscribe function", () => {
      const unsub = transport.subscribe("any:channel", () => {})
      expect(typeof unsub).toBe("function")
      expect(() => unsub()).not.toThrow()
    })

    it("never invokes the handler", () => {
      const handler = jest.fn()
      transport.subscribe("any:channel", handler)
      expect(handler).not.toHaveBeenCalled()
    })

    it("safely tolerates repeat unsubscribe calls", () => {
      const unsub = transport.subscribe("any:channel", () => {})
      expect(() => {
        unsub()
        unsub()
        unsub()
      }).not.toThrow()
    })
  })
})
