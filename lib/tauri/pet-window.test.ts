/**
 * @jest-environment jsdom
 */

const mockInvoke = jest.fn()
jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
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
} from "./pet-window"

let warnSpy: jest.SpyInstance

beforeEach(() => {
  mockInvoke.mockReset()
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
    expect(mockInvoke).not.toHaveBeenCalled()
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
    expect(warnSpy).toHaveBeenCalledTimes(13)
  })
})
