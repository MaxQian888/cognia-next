/**
 * @jest-environment jsdom
 */

// Platform probe — reveal is Tauri-only. Preserve the module's other exports.
let mockIsTauri = false
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => mockIsTauri,
}))

// `@/lib/tauri/os` transitively loads the heavy Tauri transport chain (which
// calls `isTauri()` at module init → a TDZ crash under this file's mock), so
// stub the one leaf reveal uses. It also lets us drive the macOS branch.
let mockIsMac = false
jest.mock("@/lib/tauri/os", () => ({ isMacPlatform: () => mockIsMac }))

const revealPetWindowMock = jest.fn().mockResolvedValue(true)
const revealIslandWindowMock = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/tauri/pet-window", () => ({
  revealPetWindow: (focus: boolean, label: string) => revealPetWindowMock(focus, label),
  revealIslandWindow: (focus: boolean) => revealIslandWindowMock(focus),
}))

let mockWindowRole: ReturnType<typeof import("@/lib/pet/window-role").getPetWindowRole> = "overlay"
jest.mock("@/lib/pet/window-role", () => ({
  getPetWindowRole: () => mockWindowRole,
  PET_WINDOW_LABEL: "pet",
  PET_POPUP_WINDOW_LABEL: "pet-popup",
  ISLAND_WINDOW_LABEL: "island",
}))

// Tauri window API reached via dynamic import inside the reveal.
const showMock = jest.fn().mockResolvedValue(undefined)
const setFocusMock = jest.fn().mockResolvedValue(undefined)
const innerSizeMock = jest.fn().mockResolvedValue({ width: 200, height: 240 })
const setSizeMock = jest.fn().mockResolvedValue(undefined)
const setResizableMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    show: showMock,
    setFocus: setFocusMock,
    innerSize: innerSizeMock,
    setSize: setSizeMock,
    setResizable: setResizableMock,
  }),
}))
jest.mock("@tauri-apps/api/dpi", () => ({
  PhysicalSize: class {
    constructor(
      public width: number,
      public height: number
    ) {}
  },
}))

import { schedulePetWindowReveal } from "./reveal"

const rafCallbacks: FrameRequestCallback[] = []
let rafSpy: jest.SpyInstance
let cancelRafSpy: jest.SpyInstance

/** Run every queued rAF callback (draining the queue snapshot taken first). */
function flushRaf() {
  const pending = rafCallbacks.splice(0, rafCallbacks.length)
  for (const cb of pending) cb(performance.now())
}

/** Let the reveal's dynamic imports + awaited window ops settle. */
async function flushAsync() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  mockIsTauri = false
  mockIsMac = false
  mockWindowRole = "overlay"
  showMock.mockClear()
  setFocusMock.mockClear()
  innerSizeMock.mockClear()
  innerSizeMock.mockResolvedValue({ width: 200, height: 240 })
  setSizeMock.mockClear()
  setResizableMock.mockClear()
  revealPetWindowMock.mockClear()
  revealIslandWindowMock.mockClear()
  rafCallbacks.length = 0
  rafSpy = jest.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    rafCallbacks.push(cb)
    return rafCallbacks.length
  })
  cancelRafSpy = jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {})
})

afterEach(() => {
  rafSpy.mockRestore()
  cancelRafSpy.mockRestore()
})

describe("schedulePetWindowReveal", () => {
  it("is a no-op off Tauri (web / tests never open pet windows)", () => {
    const cancel = schedulePetWindowReveal()
    expect(rafSpy).not.toHaveBeenCalled()
    cancel() // must be safe to call
    expect(cancelRafSpy).not.toHaveBeenCalled()
  })

  it("shows the window only after two rAFs, then forces a resize recomposite", async () => {
    mockIsTauri = true
    schedulePetWindowReveal()

    // Not shown until BOTH rAFs (layout + post-commit) have run.
    expect(showMock).not.toHaveBeenCalled()
    flushRaf() // rAF #1 only schedules rAF #2
    expect(showMock).not.toHaveBeenCalled()
    flushRaf() // rAF #2 runs the reveal (dynamic import + show)
    await flushAsync()

    expect(showMock).toHaveBeenCalledTimes(1)
    // No focus by default — the sprite overlay must never steal focus.
    expect(setFocusMock).not.toHaveBeenCalled()
    // Windows quirk workaround: +1px nudge, restore, re-pin resizable(false).
    expect(setResizableMock).toHaveBeenNthCalledWith(1, true)
    expect(setSizeMock).toHaveBeenCalledTimes(2)
    expect(setSizeMock.mock.calls[0][0]).toMatchObject({ width: 200, height: 241 })
    expect(setSizeMock.mock.calls[1][0]).toMatchObject({ width: 200, height: 240 })
    expect(setResizableMock).toHaveBeenNthCalledWith(2, false)
  })

  it("skips the resize nudge on macOS (protects the NSPanel style mask)", async () => {
    mockIsTauri = true
    mockIsMac = true
    schedulePetWindowReveal()
    flushRaf()
    flushRaf()
    await flushAsync()

    // Native NSPanel reveal uses `orderFrontRegardless`, so the pet remains
    // visible without activating Cognia or racing generic NSWindow.show().
    expect(revealPetWindowMock).toHaveBeenCalledWith(false, "pet")
    expect(showMock).not.toHaveBeenCalled()
    expect(setResizableMock).not.toHaveBeenCalled()
    expect(setSizeMock).not.toHaveBeenCalled()
  })

  it("asks the native macOS panel to become key only for the popup", async () => {
    mockIsTauri = true
    mockIsMac = true
    mockWindowRole = "popup"
    schedulePetWindowReveal({ focus: true })
    flushRaf()
    flushRaf()
    await flushAsync()

    expect(revealPetWindowMock).toHaveBeenCalledWith(true, "pet-popup")
    expect(revealIslandWindowMock).not.toHaveBeenCalled()
    expect(showMock).not.toHaveBeenCalled()
    expect(setFocusMock).not.toHaveBeenCalled()
  })

  it("routes the macOS island reveal to the island-specific NSPanel command", async () => {
    mockIsTauri = true
    mockIsMac = true
    mockWindowRole = "island"
    schedulePetWindowReveal({ focus: true })
    flushRaf()
    flushRaf()
    await flushAsync()

    expect(revealIslandWindowMock).toHaveBeenCalledWith(true)
    expect(revealPetWindowMock).not.toHaveBeenCalled()
    expect(showMock).not.toHaveBeenCalled()
    expect(setFocusMock).not.toHaveBeenCalled()
  })

  it("focuses after showing when focus is requested (popup blur-to-close)", async () => {
    mockIsTauri = true
    schedulePetWindowReveal({ focus: true })
    flushRaf()
    flushRaf()
    await flushAsync()

    expect(showMock).toHaveBeenCalledTimes(1)
    expect(setFocusMock).toHaveBeenCalledTimes(1)
    // Focus must land after show (an invisible window cannot take focus).
    expect(showMock.mock.invocationCallOrder[0]).toBeLessThan(
      setFocusMock.mock.invocationCallOrder[0]
    )
  })

  it("cancel before the rAFs fire prevents the reveal entirely", async () => {
    mockIsTauri = true
    const cancel = schedulePetWindowReveal()
    cancel()
    expect(cancelRafSpy).toHaveBeenCalled()
    flushRaf()
    flushRaf()
    await flushAsync()
    expect(showMock).not.toHaveBeenCalled()
  })

  it("cancel while the dynamic import is in flight aborts before showing", async () => {
    mockIsTauri = true
    const cancel = schedulePetWindowReveal()
    flushRaf()
    flushRaf() // reveal kicked off; imports are pending microtasks
    cancel()
    await flushAsync()
    expect(showMock).not.toHaveBeenCalled()
  })

  it("cancel between show and the nudge skips the resize dance", async () => {
    mockIsTauri = true
    let cancel: () => void = () => {}
    innerSizeMock.mockImplementation(async () => {
      cancel() // flips the cancelled flag before the post-innerSize check
      return { width: 200, height: 240 }
    })
    cancel = schedulePetWindowReveal()
    flushRaf()
    flushRaf()
    await flushAsync()
    expect(showMock).toHaveBeenCalledTimes(1)
    expect(setResizableMock).not.toHaveBeenCalled()
    expect(setSizeMock).not.toHaveBeenCalled()
  })

  it("swallows window-op failures (best-effort reveal)", async () => {
    mockIsTauri = true
    showMock.mockRejectedValueOnce(new Error("denied"))
    schedulePetWindowReveal()
    flushRaf()
    flushRaf()
    await flushAsync()
    // No throw, and the nudge never ran.
    expect(setSizeMock).not.toHaveBeenCalled()
  })
})
