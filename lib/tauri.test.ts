import { greet, isCapacitor, isTauri, transport } from "./tauri"

const TAURI_KEY = "__TAURI_INTERNALS__"
const CAPACITOR_KEY = "Capacitor"

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>)[TAURI_KEY] = {}
  else delete (window as unknown as Record<string, unknown>)[TAURI_KEY]
}

function setCapacitor(state: "native" | "web" | "absent") {
  const w = window as unknown as Record<string, unknown>
  if (state === "absent") {
    delete w[CAPACITOR_KEY]
    return
  }
  w[CAPACITOR_KEY] = {
    isNativePlatform: () => state === "native",
  }
}

describe("lib/tauri", () => {
  beforeEach(() => {
    setTauri(false)
    setCapacitor("absent")
  })

  afterEach(() => {
    setTauri(false)
    setCapacitor("absent")
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

  describe("isCapacitor", () => {
    it("returns false when window.Capacitor is absent", () => {
      expect(isCapacitor()).toBe(false)
    })

    it("returns false when Capacitor is present but isNativePlatform() is false (Capacitor web build)", () => {
      setCapacitor("web")
      expect(isCapacitor()).toBe(false)
    })

    it("returns true when Capacitor.isNativePlatform() returns true", () => {
      setCapacitor("native")
      expect(isCapacitor()).toBe(true)
    })

    it("returns false when Capacitor exists but lacks isNativePlatform", () => {
      ;(window as unknown as Record<string, unknown>)[CAPACITOR_KEY] = {}
      expect(isCapacitor()).toBe(false)
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
