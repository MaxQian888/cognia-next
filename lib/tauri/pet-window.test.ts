/**
 * @jest-environment jsdom
 */

const mockInvoke = jest.fn()
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}))

const mockListen = jest.fn()
jest.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => mockListen(...args),
}))

let mockIsTauri = true
jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri,
}))

import {
  openPetWindow,
  closePetWindow,
  destroyPetWindow,
  setPetClickThrough,
  setPetWindowPosition,
  getPetWindowPosition,
  getPetWorkArea,
  getPetSurfaces,
  isPetWindowOpen,
  showMainWindow,
  openPetPopup,
  closePetPopup,
  resizePetPopup,
  revealPetWindow,
  onPetNativeStateChanged,
  onPetSuspend,
  onPetResume,
  onPetWorkAreaChanged,
  onPetPopupHidden,
} from "./pet-window"

let warnSpy: jest.SpyInstance

beforeEach(() => {
  mockInvoke.mockReset()
  mockListen.mockReset()
  mockIsTauri = true
  warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

describe("lib/tauri/pet-window — happy path command mapping", () => {
  it("openPetWindow forwards opts and resolves true", async () => {
    mockInvoke.mockResolvedValue(undefined)
    const opts = { width: 128, height: 160, x: 10, y: 20, clickThrough: false }
    await expect(openPetWindow(opts)).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith("open_pet_window", { opts })
  })

  it("closePetWindow invokes close_pet_window", async () => {
    mockInvoke.mockResolvedValue(undefined)
    await expect(closePetWindow()).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith("close_pet_window")
  })

  it("destroyPetWindow invokes destroy_pet_window", async () => {
    mockInvoke.mockResolvedValue(undefined)
    await expect(destroyPetWindow()).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith("destroy_pet_window")
  })

  it("setPetClickThrough passes the camelCased ignore flag", async () => {
    mockInvoke.mockResolvedValue(undefined)
    await expect(setPetClickThrough(true)).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith("pet_window_set_ignore_cursor_events", { ignore: true })
  })

  it("setPetWindowPosition passes x/y", async () => {
    mockInvoke.mockResolvedValue(undefined)
    await expect(setPetWindowPosition(3, 4)).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith("pet_window_set_position", { x: 3, y: 4 })
  })

  it("getPetWindowPosition returns the position object", async () => {
    mockInvoke.mockResolvedValue({ x: 5, y: 6 })
    await expect(getPetWindowPosition()).resolves.toEqual({ x: 5, y: 6 })
    expect(mockInvoke).toHaveBeenCalledWith("pet_window_get_position")
  })

  it("getPetWorkArea returns the work-area DTO", async () => {
    const area = { x: 0, y: 0, width: 2560, height: 1400, scaleFactor: 1.25 }
    mockInvoke.mockResolvedValue(area)
    await expect(getPetWorkArea()).resolves.toEqual(area)
    expect(mockInvoke).toHaveBeenCalledWith("pet_window_get_work_area")
  })

  it("getPetSurfaces unwraps the surfaces array", async () => {
    const surfaces = [{ x: 100, y: 300, width: 400 }]
    mockInvoke.mockResolvedValue({ surfaces })
    await expect(getPetSurfaces()).resolves.toEqual(surfaces)
    expect(mockInvoke).toHaveBeenCalledWith("pet_window_get_surfaces")
  })

  it("getPetSurfaces returns [] when the result is null", async () => {
    mockInvoke.mockResolvedValue(null)
    await expect(getPetSurfaces()).resolves.toEqual([])
  })

  it("getPetWorkArea passes through a null (headless) result", async () => {
    mockInvoke.mockResolvedValue(null)
    await expect(getPetWorkArea()).resolves.toBeNull()
  })

  it("isPetWindowOpen returns the boolean result", async () => {
    mockInvoke.mockResolvedValue(true)
    await expect(isPetWindowOpen()).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith("is_pet_window_open")
  })

  it("showMainWindow invokes show_main_window", async () => {
    mockInvoke.mockResolvedValue(undefined)
    await expect(showMainWindow()).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith("show_main_window")
  })

  it("openPetPopup forwards the popup opts", async () => {
    mockInvoke.mockResolvedValue(undefined)
    const opts = { width: 330, height: 460, x: 200, y: 80 }
    await expect(openPetPopup(opts)).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith("open_pet_popup", { opts })
  })

  it("closePetPopup invokes close_pet_popup", async () => {
    mockInvoke.mockResolvedValue(undefined)
    await expect(closePetPopup()).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith("close_pet_popup")
  })

  it("resizePetPopup passes width/height", async () => {
    mockInvoke.mockResolvedValue(undefined)
    await expect(resizePetPopup(316, 416)).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith("pet_popup_resize", { width: 316, height: 416 })
  })

  it("revealPetWindow delegates first-paint reveal to the native window owner", async () => {
    mockInvoke.mockResolvedValue(undefined)
    await expect(revealPetWindow(true)).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith("reveal_pet_window", { focus: true })
  })

  it("revealPetWindow defaults to a non-activating reveal", async () => {
    mockInvoke.mockResolvedValue(undefined)
    await expect(revealPetWindow()).resolves.toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith("reveal_pet_window", { focus: false })
  })
})

describe("lib/tauri/pet-window — off Tauri", () => {
  beforeEach(() => {
    mockIsTauri = false
  })

  it("never invokes and returns benign defaults", async () => {
    await expect(openPetWindow({ width: 1, height: 1, clickThrough: false })).resolves.toBe(false)
    await expect(closePetWindow()).resolves.toBe(false)
    await expect(destroyPetWindow()).resolves.toBe(false)
    await expect(setPetClickThrough(true)).resolves.toBe(false)
    await expect(setPetWindowPosition(1, 1)).resolves.toBe(false)
    await expect(getPetWindowPosition()).resolves.toBeNull()
    await expect(getPetWorkArea()).resolves.toBeNull()
    await expect(getPetSurfaces()).resolves.toEqual([])
    await expect(isPetWindowOpen()).resolves.toBe(false)
    await expect(showMainWindow()).resolves.toBe(false)
    await expect(openPetPopup({ width: 1, height: 1, x: 0, y: 0 })).resolves.toBe(false)
    await expect(closePetPopup()).resolves.toBe(false)
    await expect(resizePetPopup(1, 1)).resolves.toBe(false)
    await expect(revealPetWindow(false)).resolves.toBe(false)
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})

describe("lib/tauri/pet-window — native event subscriptions", () => {
  /** Flush the dynamic `import()` + the two chained `.then`s inside subscribe(). */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it.each([
    ["onPetSuspend", onPetSuspend, "pet://suspend"],
    ["onPetResume", onPetResume, "pet://resume"],
    ["onPetWorkAreaChanged", onPetWorkAreaChanged, "pet://work-area-changed"],
    ["onPetPopupHidden", onPetPopupHidden, "pet-popup://hidden"],
  ])("%s listens on %s and invokes the handler", async (_name, subscribeFn, event) => {
    mockListen.mockResolvedValue(jest.fn())
    const handler = jest.fn()
    subscribeFn(handler)
    await flush()

    expect(mockListen).toHaveBeenCalledWith(event, expect.any(Function))
    mockListen.mock.calls[0][1]({ payload: undefined })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("onPetNativeStateChanged forwards a well-formed payload", async () => {
    mockListen.mockResolvedValue(jest.fn())
    const handler = jest.fn()
    onPetNativeStateChanged(handler)
    await flush()

    expect(mockListen).toHaveBeenCalledWith("pet://state-changed", expect.any(Function))
    mockListen.mock.calls[0][1]({ payload: { open: true, clickThrough: false } })
    expect(handler).toHaveBeenCalledWith({ open: true, clickThrough: false })
  })

  it.each([
    ["null", null],
    ["a partial payload", { open: true }],
    ["a mistyped payload", { open: "yes", clickThrough: false }],
  ])("onPetNativeStateChanged drops %s", async (_label, payload) => {
    mockListen.mockResolvedValue(jest.fn())
    const handler = jest.fn()
    onPetNativeStateChanged(handler)
    await flush()

    mockListen.mock.calls[0][1]({ payload })
    expect(handler).not.toHaveBeenCalled()
  })

  it("returns an inert disposer and never listens off Tauri", async () => {
    mockIsTauri = false
    const dispose = onPetSuspend(jest.fn())
    await flush()

    expect(mockListen).not.toHaveBeenCalled()
    expect(() => dispose()).not.toThrow()
  })

  it("unlistens on dispose", async () => {
    const off = jest.fn()
    mockListen.mockResolvedValue(off)
    const dispose = onPetSuspend(jest.fn())
    await flush()

    dispose()
    expect(off).toHaveBeenCalledTimes(1)
  })

  it("unlistens immediately when disposed before listen resolves", async () => {
    const off = jest.fn()
    mockListen.mockResolvedValue(off)
    const dispose = onPetSuspend(jest.fn())
    dispose() // dispose before the dynamic import settles
    await flush()

    expect(off).toHaveBeenCalledTimes(1)
  })

  it("warns and stays inert when listen() itself rejects", async () => {
    mockListen.mockRejectedValue(new Error("listen boom"))
    const dispose = onPetSuspend(jest.fn())
    await flush()

    expect(warnSpy).toHaveBeenCalledWith(
      "subscribe(pet://suspend) failed",
      expect.objectContaining({ message: "listen boom" })
    )
    expect(() => dispose()).not.toThrow()
  })

  // Regression: Tauri's async `_unlisten` evaluates `listeners[eventId].handlerId`
  // and rejects when the registration eval has not landed (StrictMode remount).
  // The disposer must swallow it — a floating `unlisten()` surfaced it as an
  // unhandled rejection that crashed the renderer.
  it("does not surface an unhandled rejection when the unlisten rejects on dispose", async () => {
    const onUnhandled = jest.fn()
    process.on("unhandledRejection", onUnhandled)
    try {
      const off = jest.fn(() => Promise.reject(new TypeError("listeners[eventId].handlerId")))
      mockListen.mockResolvedValue(off)
      const dispose = onPetSuspend(jest.fn())
      await flush()

      expect(() => dispose()).not.toThrow()
      await flush()
      expect(off).toHaveBeenCalledTimes(1)
      expect(onUnhandled).not.toHaveBeenCalled()
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })

  // Same race, early-dispose branch: `if (disposed) off()` floated its rejection
  // past the trailing `.catch`, because the promise was never returned.
  it("does not surface an unhandled rejection when the early-dispose unlisten rejects", async () => {
    const onUnhandled = jest.fn()
    process.on("unhandledRejection", onUnhandled)
    try {
      const off = jest.fn(() => Promise.reject(new TypeError("listeners[eventId].handlerId")))
      mockListen.mockResolvedValue(off)
      const dispose = onPetSuspend(jest.fn())
      dispose()
      await flush()

      expect(off).toHaveBeenCalledTimes(1)
      expect(onUnhandled).not.toHaveBeenCalled()
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })
})

describe("lib/tauri/pet-window — command rejection is swallowed", () => {
  it("each wrapper warns and returns a benign value when invoke rejects", async () => {
    mockInvoke.mockRejectedValue(new Error("boom"))
    await expect(openPetWindow({ width: 1, height: 1, clickThrough: false })).resolves.toBe(false)
    await expect(closePetWindow()).resolves.toBe(false)
    await expect(destroyPetWindow()).resolves.toBe(false)
    await expect(setPetClickThrough(true)).resolves.toBe(false)
    await expect(setPetWindowPosition(1, 1)).resolves.toBe(false)
    await expect(getPetWindowPosition()).resolves.toBeNull()
    await expect(getPetWorkArea()).resolves.toBeNull()
    await expect(getPetSurfaces()).resolves.toEqual([])
    await expect(isPetWindowOpen()).resolves.toBe(false)
    await expect(showMainWindow()).resolves.toBe(false)
    await expect(openPetPopup({ width: 1, height: 1, x: 0, y: 0 })).resolves.toBe(false)
    await expect(closePetPopup()).resolves.toBe(false)
    await expect(resizePetPopup(1, 1)).resolves.toBe(false)
    await expect(revealPetWindow()).resolves.toBe(false)
    expect(warnSpy).toHaveBeenCalledTimes(14)
  })
})
