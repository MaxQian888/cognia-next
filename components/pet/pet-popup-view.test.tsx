/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Pet read model.
const mockUsePet = jest.fn()
jest.mock("@/hooks/pet/use-pet", () => ({ usePet: (id?: string | null) => mockUsePet(id) }))

// Active Live2D model resolution (drives the popup's effective preview skin).
const mockUseActiveLive2dModel = jest.fn()
jest.mock("@/hooks/pet/use-active-live2d-model", () => ({
  useActiveLive2dModel: () => mockUseActiveLive2dModel(),
}))

// Reused interaction panel — stubbed to surface the action callbacks so we can
// assert they reach the bridge. (The real panel is tested on its own.)
jest.mock("./pet-interaction-panel", () => ({
  PetInteractionPanel: ({
    onFeed,
    onPlay,
    onPet,
    onTalk,
    skinId,
  }: {
    onFeed: () => void
    onPlay: () => void
    onPet: () => void
    onTalk: (text?: string) => void
    skinId?: string
  }) => (
    <div data-testid="pet-interaction-panel" data-skin={skinId ?? "default"}>
      <button onClick={() => onFeed()}>feed</button>
      <button onClick={() => onPlay()}>play</button>
      <button onClick={() => onPet()}>pet</button>
      <button onClick={() => onTalk("hi pet")}>talk</button>
    </div>
  ),
}))

// Cross-window bridge.
const bridgeDispose = jest.fn()
const bridgeSendInteraction = jest.fn()
const startOverlayPetBridge = jest.fn(() => ({
  dispose: bridgeDispose,
  sendInteraction: bridgeSendInteraction,
}))
jest.mock("@/lib/pet/events/cross-window-bridge", () => ({
  startOverlayPetBridge: () => startOverlayPetBridge(),
}))

// First-paint reveal — deep-tested in lib/pet/reveal.test.ts; here we assert
// the popup schedules it (with focus for blur-to-close) and cancels on unmount.
const revealCancel = jest.fn()
const schedulePetWindowReveal = jest.fn((_opts?: unknown) => revealCancel)
jest.mock("@/lib/pet/reveal", () => ({
  schedulePetWindowReveal: (opts?: unknown) => schedulePetWindowReveal(opts),
}))

// Tauri window wrappers.
const closePetPopup = jest.fn().mockResolvedValue(true)
const closePetWindow = jest.fn().mockResolvedValue(true)
const resizePetPopup = jest.fn().mockResolvedValue(true)
const setPetClickThrough = jest.fn().mockResolvedValue(true)
const showMainWindow = jest.fn().mockResolvedValue(true)
jest.mock("@/lib/tauri/pet-window", () => ({
  closePetPopup: () => closePetPopup(),
  closePetWindow: () => closePetWindow(),
  resizePetPopup: (w: number, h: number) => resizePetPopup(w, h),
  setPetClickThrough: (v: boolean) => setPetClickThrough(v),
  showMainWindow: () => showMainWindow(),
}))

// Settings store (selector form).
const saveMock = jest.fn().mockResolvedValue(undefined)
let settingsValue: unknown = {
  petSettings: { enabled: true, desktopPet: { enabled: true, clickThrough: false, size: 160 } },
}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: { settings: unknown; save: unknown }) => unknown) =>
    selector({ settings: settingsValue, save: saveMock }),
}))

import { PetPopupView } from "./pet-popup-view"

const PROFILE = { stage: "baby" }
const VIEW = { effectiveBones: { eyes: "dot" }, needs: { energy: 80, mood: 70, bond: 60 } }

// ResizeObserver shim that runs the callback once on observe (jsdom lacks it).
class MockResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe() {
    this.cb([], this as unknown as ResizeObserver)
  }
  disconnect() {}
  unobserve() {}
}

let offsetWidthSpy: PropertyDescriptor | undefined
let offsetHeightSpy: PropertyDescriptor | undefined

beforeEach(() => {
  mockUsePet.mockReset()
  mockUsePet.mockReturnValue({ profile: PROFILE, view: VIEW, loading: false })
  mockUseActiveLive2dModel.mockReset()
  // Default: no active Live2D model → the popup preview resolves to SVG.
  mockUseActiveLive2dModel.mockReturnValue({ modelId: undefined, row: undefined, coreReady: false })
  bridgeDispose.mockReset()
  bridgeSendInteraction.mockReset()
  startOverlayPetBridge.mockClear()
  revealCancel.mockClear()
  schedulePetWindowReveal.mockClear()
  closePetPopup.mockClear()
  closePetWindow.mockClear()
  resizePetPopup.mockClear()
  setPetClickThrough.mockClear()
  showMainWindow.mockClear()
  saveMock.mockClear()
  settingsValue = {
    petSettings: { enabled: true, desktopPet: { enabled: true, clickThrough: false, size: 160 } },
  }
  delete document.documentElement.dataset.petOverlay
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver
  // Non-zero measured size so the fit() path reports a real window size.
  offsetWidthSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth")
  offsetHeightSpy = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 300,
  })
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 400,
  })
})

afterEach(() => {
  if (offsetWidthSpy) Object.defineProperty(HTMLElement.prototype, "offsetWidth", offsetWidthSpy)
  if (offsetHeightSpy) Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightSpy)
})

describe("PetPopupView", () => {
  it("marks <html> transparent on mount and clears on unmount", () => {
    const { unmount } = render(<PetPopupView />)
    expect(document.documentElement.dataset.petOverlay).toBe("1")
    unmount()
    expect(document.documentElement.dataset.petOverlay).toBeUndefined()
  })

  it("schedules the focused first-paint reveal on mount and cancels on unmount", () => {
    const { unmount } = render(<PetPopupView />)
    expect(schedulePetWindowReveal).toHaveBeenCalledTimes(1)
    expect(schedulePetWindowReveal).toHaveBeenCalledWith({ focus: true })
    expect(revealCancel).not.toHaveBeenCalled()
    unmount()
    expect(revealCancel).toHaveBeenCalledTimes(1)
  })

  it("starts the bridge on mount and disposes on unmount", () => {
    const { unmount } = render(<PetPopupView />)
    expect(startOverlayPetBridge).toHaveBeenCalledTimes(1)
    unmount()
    expect(bridgeDispose).toHaveBeenCalledTimes(1)
  })

  it("renders the reused interaction panel when the profile is loaded", () => {
    render(<PetPopupView />)
    expect(screen.getByTestId("pet-interaction-panel")).toBeInTheDocument()
  })

  it("resolves the preview skin to SVG with no active model, Live2D when ready", () => {
    const { unmount } = render(<PetPopupView />)
    expect(screen.getByTestId("pet-interaction-panel").dataset.skin).toBe("svg")
    unmount()

    settingsValue = {
      petSettings: {
        enabled: true,
        skinId: "live2d",
        activeLive2dModelId: "m1",
        desktopPet: { enabled: true, clickThrough: false, size: 160 },
      },
    }
    mockUseActiveLive2dModel.mockReturnValue({ modelId: "m1", row: undefined, coreReady: true })
    render(<PetPopupView />)
    expect(screen.getByTestId("pet-interaction-panel").dataset.skin).toBe("live2d")
  })

  it("omits the panel while the profile is still loading (actions still present)", () => {
    mockUsePet.mockReturnValue({ profile: undefined, view: undefined, loading: true })
    render(<PetPopupView />)
    expect(screen.queryByTestId("pet-interaction-panel")).not.toBeInTheDocument()
    expect(screen.getByText("hideDesktopPet")).toBeInTheDocument()
  })

  it("routes panel actions to the bridge (talk carries text)", () => {
    render(<PetPopupView />)
    fireEvent.click(screen.getByText("feed"))
    fireEvent.click(screen.getByText("play"))
    fireEvent.click(screen.getByText("pet"))
    fireEvent.click(screen.getByText("talk"))
    expect(bridgeSendInteraction).toHaveBeenCalledWith("fed", undefined)
    expect(bridgeSendInteraction).toHaveBeenCalledWith("played", undefined)
    expect(bridgeSendInteraction).toHaveBeenCalledWith("petted", undefined)
    expect(bridgeSendInteraction).toHaveBeenCalledWith("talked", "hi pet")
  })

  it("click-through enables the OS flag, persists clickThrough=true, and closes the popup", () => {
    render(<PetPopupView />)
    fireEvent.click(screen.getByText("clickThrough"))
    expect(setPetClickThrough).toHaveBeenCalledWith(true)
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        petSettings: expect.objectContaining({
          desktopPet: expect.objectContaining({ clickThrough: true }),
        }),
      })
    )
    expect(closePetPopup).toHaveBeenCalledTimes(1)
  })

  it("hide closes the sprite window; show-main restores the app and closes the popup", () => {
    render(<PetPopupView />)
    fireEvent.click(screen.getByText("hideDesktopPet"))
    expect(closePetWindow).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText("showMainWindow"))
    expect(showMainWindow).toHaveBeenCalledTimes(1)
    expect(closePetPopup).toHaveBeenCalledTimes(1)
  })

  it("Esc closes the popup", () => {
    render(<PetPopupView />)
    fireEvent.keyDown(window, { key: "Escape" })
    expect(closePetPopup).toHaveBeenCalledTimes(1)
  })

  it("fits the window to the measured card size (size only, never reposition)", () => {
    render(<PetPopupView />)
    // 300x400 measured + 16 shadow margin.
    expect(resizePetPopup).toHaveBeenCalledWith(316, 416)
  })

  it("falls back gracefully when settings.petSettings is absent", () => {
    settingsValue = {}
    render(<PetPopupView />)
    fireEvent.click(screen.getByText("clickThrough"))
    expect(setPetClickThrough).toHaveBeenCalledWith(true)
    // Persists against the default desktop overlay shape.
    expect(saveMock).toHaveBeenCalled()
  })

  it("dismisses on Escape only, not other keys", () => {
    render(<PetPopupView />)
    fireEvent.keyDown(window, { key: "a" })
    expect(closePetPopup).not.toHaveBeenCalled()
  })
})
