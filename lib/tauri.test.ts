import { greet, isTauri, transport } from "./tauri"

const TAURI_KEY = "__TAURI_INTERNALS__"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

describe("lib/tauri", () => {
  beforeEach(() => {
    setTauri(false)
  })

  afterEach(() => {
    setTauri(false)
    jest.restoreAllMocks()
  })

  describe("isTauri", () => {
    it("returns false in jsdom (no Tauri marker)", () => {
      expect(isTauri()).toBe(false)
    })

    it("returns true when __TAURI_INTERNALS__ is on window", () => {
      setTauri(true)
      expect(isTauri()).toBe(true)
    })
  })

  describe("greet", () => {
    it("delegates to transport.call('greet', {name}) and returns its result", async () => {
      const callSpy = jest.spyOn(transport, "call").mockResolvedValueOnce("Hello, X!")
      const result = await greet("X")
      expect(callSpy).toHaveBeenCalledWith("greet", { name: "X" })
      expect(result).toBe("Hello, X!")
    })

    it("propagates rejection from transport.call", async () => {
      jest.spyOn(transport, "call").mockRejectedValueOnce(new Error("boom"))
      await expect(greet("X")).rejects.toThrow("boom")
    })
  })
})
