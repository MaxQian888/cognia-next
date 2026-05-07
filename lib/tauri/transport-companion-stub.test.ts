import { CompanionTransportStub } from "./transport-companion-stub"

describe("CompanionTransportStub", () => {
  let transport: CompanionTransportStub

  beforeEach(() => {
    transport = new CompanionTransportStub()
  })

  describe("call", () => {
    it("rejects with a stub-specific error including the command name", async () => {
      await expect(transport.call("greet")).rejects.toThrow(
        /companion transport not implemented yet — see M2.*greet/
      )
    })

    it("ignores args silently and still rejects", async () => {
      await expect(transport.call("any_cmd", { foo: 1, bar: "two" })).rejects.toThrow(
        /companion transport not implemented yet/
      )
    })

    it("returns a Promise (never throws synchronously)", () => {
      const result = transport.call("some_cmd")
      expect(result).toBeInstanceOf(Promise)
      result.catch(() => {})
    })

    it("error message is distinct from the WebStub message — used by M1.7 ADR diagnostics", async () => {
      await expect(transport.call("foo")).rejects.toThrow(/M2/)
      await expect(transport.call("foo")).rejects.not.toThrow(/web mode/)
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
