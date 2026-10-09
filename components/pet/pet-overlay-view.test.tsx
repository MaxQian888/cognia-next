/**
 * @jest-environment jsdom
 */
import "@/components/interactions/test-pointer-polyfill"
import { render, screen, act, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("motion/react", () => ({
  useReducedMotion: () => false,
}))

// Pet read model.
const mockUsePet = jest.fn()
jest.mock("@/hooks/pet/use-pet", () => ({ usePet: (id?: string | null) => mockUsePet(id) }))

// One-shot animation hook → controllable state for the renderer.
let animationStateValue = "idle"
jest.mock("@/hooks/pet/use-pet-animation-state", () => ({
  usePetAnimationState: () => ({ state: animationStateValue, oneShot: null }),
}))

// PetRenderer / PetBubble stubs so we assert props, not SVG internals.
const rendererProps = jest.fn()
jest.mock("./pet-renderer", () => ({
  PetRenderer: (props: unknown) => {
    rendererProps(props)
    return <div data-testid="pet-renderer" />
  },
}))
jest.mock("./pet-bubble", () => ({
  PetBubbleView: ({
    bubble,
    onAction,
  }: {
    bubble: { text: string; action?: { kind: string; tab: string } } | null
    onAction?: (a: { kind: string; tab: string }) => void
  }) =>
    bubble ? (
      <div data-testid="pet-bubble">
        {bubble.text}
        {bubble.action && onAction ? (
          <button data-testid="pet-bubble-action" onClick={() => onAction(bubble.action!)} />
        ) : null}
      </div>
    ) : null,
}))

// Cross-window bridge.
const bridgeDispose = jest.fn()
const bridgeSendInteraction = jest.fn()
const bridgeSendOpenConsole = jest.fn()
const startOverlayPetBridge = jest.fn(() => ({
  dispose: bridgeDispose,
  sendInteraction: bridgeSendInteraction,
  sendOpenConsole: bridgeSendOpenConsole,
}))
jest.mock("@/lib/pet/events/cross-window-bridge", () => ({
  startOverlayPetBridge: () => startOverlayPetBridge(),
}))

// Active Live2D model probe — default to no model / core not ready so the
// effective skin resolves to "svg". Tests that exercise the live2d path
// override the return value.
const useActiveLive2dModel = jest.fn(() => ({
  modelId: undefined as string | undefined,
  row: undefined,
  coreReady: false as boolean | undefined,
}))
jest.mock("@/hooks/pet/use-active-sprite-pack", () => ({
  useActiveSpritePack: () => ({ packId: undefined, row: undefined }),
}))
jest.mock("@/hooks/pet/use-active-live2d-model", () => ({
  useActiveLive2dModel: () => useActiveLive2dModel(),
}))

// Tauri window wrappers.
const getPetWindowPosition = jest.fn()
const setPetWindowPosition = jest.fn()
const openPetPopup = jest.fn()
const showMainWindow = jest.fn()
const revealPetWindowMock = jest.fn().mockResolvedValue(true)
let workAreaValue: unknown = { x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1 }
jest.mock("@/lib/tauri/pet-window", () => ({
  getPetWindowPosition: () => getPetWindowPosition(),
  getPetCursorPosition: jest.fn().mockResolvedValue(null),
  setPetWindowPosition: (x: number, y: number) => setPetWindowPosition(x, y),
  getPetWorkArea: () => Promise.resolve(workAreaValue),
  openPetPopup: (opts: unknown) => openPetPopup(opts),
  showMainWindow: () => showMainWindow(),
  revealPetWindow: (focus: boolean, label: string) => revealPetWindowMock(focus, label),
  // Native event subscriptions — inert disposers in jsdom.
  onPetSuspend: () => () => {},
  onPetResume: () => () => {},
  onPetWorkAreaChanged: () => () => {},
}))

// Platform probe — the post-paint window reveal is Tauri-only. Default false so
// the existing suite (which asserts no window ops fire on mount) is unchanged;
// the reveal test flips it. Preserve the module's other exports.
//
// MUST be `var`, not `let`: `lib/tauri/transport-instance.ts` calls the mocked
// `isTauri()` at MODULE LOAD (import time), before this file's body runs — a
// `let` binding is in its temporal dead zone then and throws; `var` hoists to
// `undefined`, which reads as the intended "not tauri" default.
// eslint-disable-next-line no-var
var mockIsTauri = false
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => mockIsTauri,
}))

// OS family: desktop units are points on macOS (one per CSS px on every
// display), physical pixels elsewhere. Default "not macOS" so the existing
// suite exercises the pixel path; the macOS cases flip it.
let mockIsMacOs = false
jest.mock("@/lib/platform/os", () => ({
  ...jest.requireActual("@/lib/platform/os"),
  isMacOs: () => mockIsMacOs,
}))

// Tauri window API used by the post-paint reveal effect (dynamic import).
const revealShowMock = jest.fn().mockResolvedValue(undefined)
const revealInnerSizeMock = jest.fn().mockResolvedValue({ width: 200, height: 240 })
const revealSetSizeMock = jest.fn().mockResolvedValue(undefined)
const revealSetResizableMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    show: revealShowMock,
    isVisible: jest.fn().mockResolvedValue(true),
    innerSize: revealInnerSizeMock,
    setSize: revealSetSizeMock,
    setResizable: revealSetResizableMock,
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

// Locomotion hook — deep-tested on its own; here we record the wiring args and
// surface a controllable beginThrow.
const locomotionArgs = jest.fn()
const beginThrowMock = jest.fn()
const settleAtMock = jest.fn()
jest.mock("@/hooks/pet/use-pet-locomotion", () => ({
  usePetLocomotion: (args: unknown) => {
    locomotionArgs(args)
    return {
      locomotion: { mode: "resting", facing: "right" },
      scaleFactor: 1,
      beginThrow: beginThrowMock,
      settleAt: settleAtMock,
    }
  },
}))

// Pet store bubble selector.
let bubbleValue: {
  text: string
  origin: string
  action?: { kind: string; tab: string }
} | null = null
const mockEnqueueOneShot = jest.fn()
const mockSetBubble = jest.fn()
jest.mock("@/stores/pet/pet-store", () => ({
  usePetStore: Object.assign(
    (selector: (s: { bubble: unknown }) => unknown) => selector({ bubble: bubbleValue }),
    { getState: () => ({ enqueueOneShot: mockEnqueueOneShot, setBubble: mockSetBubble }) }
  ),
}))

// Settings store — both the hook selector form and the imperative getState()
// snapshot (used by the settle-persist path).
const saveMock = jest.fn().mockResolvedValue(undefined)
let settingsValue: unknown = {}
jest.mock("@/stores/settings", () => {
  const useSettingsStore = (selector: (s: { settings: unknown; save: unknown }) => unknown) =>
    selector({ settings: settingsValue, save: saveMock })
  useSettingsStore.getState = () => ({ settings: settingsValue, save: saveMock })
  return { useSettingsStore }
})

// The cross-window pet-settings writer, reduced to its contract: merge into
// the latest persisted record (`settingsValue` stands in for Dexie) and write
// it through the store's `save`.
const followerDispose = jest.fn()
const startPetSettingsFollower = jest.fn(() => followerDispose)
jest.mock("@/lib/pet/settings-sync", () => ({
  startPetSettingsFollower: () => startPetSettingsFollower(),
  updateDesktopPetSettings: async (
    patch: (latest: Record<string, unknown>) => Record<string, unknown>,
    defaults: Record<string, unknown>
  ) => {
    const latest = ((settingsValue as { petSettings?: Record<string, unknown> }).petSettings ??
      {}) as Record<string, unknown>
    const desktop = (latest.desktopPet as Record<string, unknown> | undefined) ?? defaults
    const next = { ...latest, desktopPet: { ...desktop, ...patch(desktop) } }
    await saveMock({ petSettings: next })
    return next
  },
}))

import { PetOverlayView } from "./pet-overlay-view"
import { getPetCursorPosition } from "@/lib/tauri/pet-window"
import { POPUP_INITIAL_HEIGHT, POPUP_INITIAL_WIDTH } from "@/lib/pet/popup-geometry"
import { petBoxScreenRect } from "@/lib/pet/overlay-geometry"

const PROFILE = { stage: "baby" }
const VIEW = {
  effectiveBones: { eyes: "dot" },
  condition: "well",
  effectiveStats: { debugging: 0, patience: 0, chaos: 0, wisdom: 0, snark: 0 },
}

function withPet(view: Record<string, unknown> = VIEW) {
  mockUsePet.mockReturnValue({ profile: PROFILE, view, loading: false })
}

let rafSpy: jest.SpyInstance
let cancelRafSpy: jest.SpyInstance
const rafCallbacks: FrameRequestCallback[] = []

beforeEach(() => {
  mockIsTauri = false
  mockIsMacOs = false
  ;(getPetCursorPosition as jest.Mock).mockResolvedValue(null)
  animationStateValue = "idle"
  revealShowMock.mockClear()
  revealInnerSizeMock.mockClear()
  revealInnerSizeMock.mockResolvedValue({ width: 200, height: 240 })
  revealSetSizeMock.mockClear()
  revealSetResizableMock.mockClear()
  mockUsePet.mockReset()
  rendererProps.mockReset()
  bridgeDispose.mockReset()
  bridgeSendInteraction.mockReset()
  bridgeSendOpenConsole.mockReset()
  showMainWindow.mockReset()
  mockSetBubble.mockReset()
  startOverlayPetBridge.mockClear()
  getPetWindowPosition.mockReset()
  getPetWindowPosition.mockResolvedValue({ x: 100, y: 200 })
  setPetWindowPosition.mockReset()
  setPetWindowPosition.mockResolvedValue(true)
  openPetPopup.mockReset()
  openPetPopup.mockResolvedValue(true)
  workAreaValue = { x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1 }
  useActiveLive2dModel.mockReset()
  useActiveLive2dModel.mockReturnValue({ modelId: undefined, row: undefined, coreReady: false })
  saveMock.mockClear()
  settleAtMock.mockClear()
  beginThrowMock.mockClear()
  revealPetWindowMock.mockClear()
  startPetSettingsFollower.mockClear()
  followerDispose.mockClear()
  Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true })
  bubbleValue = null
  settingsValue = {
    petSettings: {
      enabled: true,
      anchor: "bottom-right",
      motion: "auto",
      mutedBubbles: false,
      size: 96,
      skinId: "svg",
      desktopPet: { enabled: true, clickThrough: false, size: 160, position: null },
    },
  }
  delete document.documentElement.dataset.petOverlay
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

function flushRaf() {
  const cbs = [...rafCallbacks]
  rafCallbacks.length = 0
  for (const cb of cbs) cb(0)
}

describe("PetOverlayView", () => {
  it("marks <html> transparent on mount and clears on unmount", () => {
    withPet()
    const { unmount } = render(<PetOverlayView />)
    expect(document.documentElement.dataset.petOverlay).toBe("1")
    unmount()
    expect(document.documentElement.dataset.petOverlay).toBeUndefined()
  })

  it("does not reveal the window off Tauri (web/tests never open it)", async () => {
    mockIsTauri = false
    withPet()
    await act(async () => {
      render(<PetOverlayView />)
    })
    await act(async () => {
      flushRaf()
      flushRaf()
    })
    expect(revealShowMock).not.toHaveBeenCalled()
  })

  it("reveals the sprite window only after the first painted frame on Tauri", async () => {
    mockIsTauri = true
    // This webview is the "pet" overlay window (role resolution reads the
    // label synchronously from the Tauri internals).
    const w = window as unknown as { __TAURI_INTERNALS__?: unknown }
    w.__TAURI_INTERNALS__ = { metadata: { currentWebview: { label: "pet" } } }
    withPet()
    await act(async () => {
      render(<PetOverlayView />)
    })
    // Not shown until BOTH rAFs (layout + post-commit) have run.
    expect(revealPetWindowMock).not.toHaveBeenCalled()
    await act(async () => {
      flushRaf() // rAF #1 schedules rAF #2
    })
    expect(revealPetWindowMock).not.toHaveBeenCalled()
    await act(async () => {
      flushRaf() // rAF #2 runs reveal (dynamic import + native reveal)
    })
    // Through the generation-guarded native owner, never a raw show(), and
    // without focus: the sprite never takes it.
    expect(revealPetWindowMock).toHaveBeenCalledWith(false, "pet")
    expect(revealShowMock).not.toHaveBeenCalled()
    // Nudge the physical size by 1px then restore it, to force the transparent
    // surface to recomposite (the Windows black-until-resize quirk). Resizing is
    // briefly enabled so the non-resizable window doesn't clamp the nudge.
    expect(revealSetResizableMock).toHaveBeenNthCalledWith(1, true)
    expect(revealSetSizeMock).toHaveBeenCalledTimes(2)
    expect(revealSetSizeMock.mock.calls[0][0]).toMatchObject({ width: 200, height: 241 })
    expect(revealSetSizeMock.mock.calls[1][0]).toMatchObject({ width: 200, height: 240 })
    expect(revealSetResizableMock).toHaveBeenNthCalledWith(2, false)
    delete w.__TAURI_INTERNALS__
  })

  it("follows pet-settings writes from the other windows and stops on unmount", () => {
    withPet()
    const { unmount } = render(<PetOverlayView />)
    expect(startPetSettingsFollower).toHaveBeenCalledTimes(1)
    unmount()
    expect(followerDispose).toHaveBeenCalledTimes(1)
  })

  it("starts the overlay bridge on mount and disposes on unmount", () => {
    withPet()
    const { unmount } = render(<PetOverlayView />)
    expect(startOverlayPetBridge).toHaveBeenCalledTimes(1)
    unmount()
    expect(bridgeDispose).toHaveBeenCalledTimes(1)
  })

  it("renders the pet with the desktopPet size and effective skin", () => {
    withPet()
    render(<PetOverlayView />)
    expect(screen.getByTestId("pet-renderer")).toBeInTheDocument()
    expect(rendererProps).toHaveBeenCalledWith(
      expect.objectContaining({
        size: 160,
        skinId: "svg",
        bones: VIEW.effectiveBones,
        stage: "baby",
      })
    )
  })

  it("uses the live2d skin when the user selected it", () => {
    withPet()
    // Active model + ready core so resolveEffectiveSkin yields "live2d".
    useActiveLive2dModel.mockReturnValue({ modelId: "m1", row: undefined, coreReady: true })
    settingsValue = {
      petSettings: {
        enabled: true,
        anchor: "bottom-right",
        motion: "auto",
        mutedBubbles: false,
        size: 96,
        skinId: "live2d",
        activeLive2dModelId: "m1",
        desktopPet: { enabled: true, clickThrough: false, size: 128, position: null },
      },
    }
    render(<PetOverlayView />)
    expect(rendererProps).toHaveBeenCalledWith(
      expect.objectContaining({ skinId: "live2d", size: 128 })
    )
  })

  it("falls back to DEFAULT_PET_SETTINGS when settings are unloaded", () => {
    withPet()
    settingsValue = undefined
    render(<PetOverlayView />)
    // DEFAULT_PET_DESKTOP_OVERLAY.size === 128
    expect(rendererProps).toHaveBeenCalledWith(
      expect.objectContaining({ size: 128, skinId: "svg" })
    )
  })

  it("forces reduced motion when motion preference is 'reduced'", () => {
    withPet()
    settingsValue = {
      petSettings: {
        enabled: true,
        anchor: "bottom-right",
        motion: "reduced",
        mutedBubbles: false,
        size: 96,
        desktopPet: { enabled: true, clickThrough: false, size: 128, position: null },
      },
    }
    render(<PetOverlayView />)
    expect(rendererProps).toHaveBeenCalledWith(expect.objectContaining({ reducedMotion: true }))
  })

  it("overlays 'unwell' onto a resting state when the care condition is unwell", () => {
    withPet({ ...VIEW, condition: "unwell" })
    render(<PetOverlayView />)
    expect(rendererProps).toHaveBeenCalledWith(expect.objectContaining({ state: "unwell" }))
  })

  it("keeps the resting state when the care condition is well", () => {
    withPet()
    render(<PetOverlayView />)
    expect(rendererProps).toHaveBeenCalledWith(expect.objectContaining({ state: "idle" }))
  })

  it("keeps an expressive state even while unwell", () => {
    animationStateValue = "thinking"
    withPet({ ...VIEW, condition: "unwell" })
    render(<PetOverlayView />)
    expect(rendererProps).toHaveBeenCalledWith(expect.objectContaining({ state: "thinking" }))
  })

  it("renders the bubble when present", () => {
    withPet()
    bubbleValue = { text: "hello", origin: "system" }
    render(<PetOverlayView />)
    expect(screen.getByTestId("pet-bubble")).toHaveTextContent("hello")
  })

  it("routes a bubble action to the main window, which owns the router", () => {
    withPet()
    bubbleValue = {
      text: "report ready",
      origin: "system",
      action: { kind: "open-console", tab: "insights" },
    }
    render(<PetOverlayView />)
    fireEvent.click(screen.getByTestId("pet-bubble-action"))
    expect(showMainWindow).toHaveBeenCalledTimes(1)
    expect(bridgeSendOpenConsole).toHaveBeenCalledWith("insights")
    // Acted on, so it goes away rather than lingering over the desktop.
    expect(mockSetBubble).toHaveBeenCalledWith(null)
  })

  it("renders nothing for the pet until the profile loads (still transparent)", () => {
    mockUsePet.mockReturnValue({ profile: undefined, view: undefined, loading: true })
    render(<PetOverlayView />)
    expect(screen.queryByTestId("pet-renderer")).toBeNull()
    expect(screen.getByTestId("pet-overlay-root")).toBeInTheDocument()
  })

  it("falls back to default overlay size when desktopPet is absent", () => {
    withPet()
    settingsValue = {
      petSettings: {
        enabled: true,
        anchor: "bottom-right",
        motion: "auto",
        mutedBubbles: false,
        size: 96,
      },
    }
    render(<PetOverlayView />)
    expect(rendererProps).toHaveBeenCalledWith(expect.objectContaining({ size: 128 }))
  })

  it("dragging beyond the threshold moves the window and persists the resting position", async () => {
    withPet()
    render(<PetOverlayView />)
    const pet = screen.getByTestId("pet-overlay-pet")

    await act(async () => {
      fireEvent.pointerDown(pet, { button: 0, pointerId: 1, screenX: 500, screenY: 500 })
      // resolve the async getPetWindowPosition()
      await Promise.resolve()
      await Promise.resolve()
    })

    act(() => {
      fireEvent.pointerMove(pet, { pointerId: 1, screenX: 540, screenY: 530 })
      flushRaf()
    })
    // base window (100,200) + delta (40,30)
    expect(setPetWindowPosition).toHaveBeenCalledWith(140, 230)

    await act(async () => {
      fireEvent.pointerUp(pet, { pointerId: 1, screenX: 540, screenY: 530 })
      await Promise.resolve()
    })
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        petSettings: expect.objectContaining({
          desktopPet: expect.objectContaining({ position: { x: 140, y: 230, space: "desktop" } }),
        }),
      })
    )
    // A placement hands the spot to the wander engine, so its next walk
    // starts here instead of snapping back to the pre-drag position.
    expect(settleAtMock).toHaveBeenCalledWith(140, 230)
    expect(beginThrowMock).not.toHaveBeenCalled()
  })

  it("converts CSS-pixel drag deltas to desktop pixels on a 2x Windows display", async () => {
    withPet()
    workAreaValue = { x: 0, y: 0, width: 3456, height: 2234, scaleFactor: 2 }
    render(<PetOverlayView />)
    const pet = screen.getByTestId("pet-overlay-pet")

    await act(async () => {
      fireEvent.pointerDown(pet, { button: 0, pointerId: 31, screenX: 500, screenY: 500 })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => {
      fireEvent.pointerMove(pet, { pointerId: 31, screenX: 540, screenY: 530 })
      flushRaf()
    })
    // base window (100,200) + CSS delta (40,30) × 2 — the window keeps pace
    // with the cursor instead of trailing at half speed.
    expect(setPetWindowPosition).toHaveBeenCalledWith(180, 260)
    await act(async () => {
      fireEvent.pointerUp(pet, { pointerId: 31, screenX: 540, screenY: 530 })
      await Promise.resolve()
    })
    expect(settleAtMock).toHaveBeenCalledWith(180, 260)
  })

  it("falls back to devicePixelRatio when the monitor scale is unknown", async () => {
    withPet()
    workAreaValue = null
    Object.defineProperty(window, "devicePixelRatio", { value: 1.5, configurable: true })
    render(<PetOverlayView />)
    const pet = screen.getByTestId("pet-overlay-pet")
    await act(async () => {
      fireEvent.pointerDown(pet, { button: 0, pointerId: 32, screenX: 0, screenY: 0 })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => {
      fireEvent.pointerMove(pet, { pointerId: 32, screenX: 40, screenY: 20 })
      flushRaf()
    })
    expect(setPetWindowPosition).toHaveBeenCalledWith(160, 230)
  })

  it("drags 1:1 in points on a Retina Mac, whatever the pixel ratio", async () => {
    // macOS reports positions in points and one point per CSS px on every
    // display, so a Retina pixel ratio must not double the drag (the pet
    // used to jump ahead of the cursor, then snap when it crossed onto a 1x
    // display).
    withPet()
    mockIsMacOs = true
    workAreaValue = { x: 0, y: 25, width: 1512, height: 957, scaleFactor: 1 }
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true })
    render(<PetOverlayView />)
    const pet = screen.getByTestId("pet-overlay-pet")
    await act(async () => {
      fireEvent.pointerDown(pet, { button: 0, pointerId: 33, screenX: 500, screenY: 500 })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => {
      fireEvent.pointerMove(pet, { pointerId: 33, screenX: 540, screenY: 530 })
      flushRaf()
    })
    expect(setPetWindowPosition).toHaveBeenCalledWith(140, 230)
  })

  it("keeps a macOS drag in points before the work area is known", async () => {
    withPet()
    mockIsMacOs = true
    workAreaValue = null
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true })
    render(<PetOverlayView />)
    const pet = screen.getByTestId("pet-overlay-pet")
    await act(async () => {
      fireEvent.pointerDown(pet, { button: 0, pointerId: 34, screenX: 0, screenY: 0 })
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => {
      fireEvent.pointerMove(pet, { pointerId: 34, screenX: 40, screenY: 20 })
      flushRaf()
    })
    expect(setPetWindowPosition).toHaveBeenCalledWith(140, 220)
  })

  it("aims the gaze at the native cursor in points on a Retina Mac", async () => {
    // jsdom: the window sits at screen (0, 0) and is 1024×768 CSS px, so the
    // 160px pet box is centered at (512, 688). On macOS the cursor comes back
    // in points too; scaling the box by the pixel ratio put it at twice its
    // spot and the pet looked away from a cursor right on top of it.
    withPet()
    mockIsMacOs = true
    Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true })
    ;(getPetCursorPosition as jest.Mock).mockResolvedValue({ x: 512, y: 688 })
    await act(async () => {
      render(<PetOverlayView />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const lookTarget = (
      rendererProps.mock.calls.at(-1)![0] as { lookTarget?: { x: number; y: number } }
    ).lookTarget
    expect(lookTarget?.x).toBeCloseTo(0)
    expect(lookTarget?.y).toBeCloseTo(0)
  })

  it("a click (no drag) sends a 'petted' interaction and does not persist", async () => {
    withPet()
    render(<PetOverlayView />)
    const pet = screen.getByTestId("pet-overlay-pet")

    await act(async () => {
      fireEvent.pointerDown(pet, { button: 0, pointerId: 2, screenX: 10, screenY: 10 })
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      // movement below threshold → click
      fireEvent.pointerMove(pet, { pointerId: 2, screenX: 11, screenY: 11 })
      fireEvent.pointerUp(pet, { pointerId: 2, screenX: 11, screenY: 11 })
      await Promise.resolve()
    })
    expect(bridgeSendInteraction).toHaveBeenCalledWith("petted")
    expect(setPetWindowPosition).not.toHaveBeenCalled()
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("a tap enqueues a zone-specific reaction while still sending 'petted'", async () => {
    withPet()
    render(<PetOverlayView />)
    const pet = screen.getByTestId("pet-overlay-pet")
    mockEnqueueOneShot.mockClear()

    await act(async () => {
      // clientY 0 → top band → "head" zone → "love" reaction (jsdom rect is 0×0,
      // so local coords equal the client coords).
      fireEvent.pointerDown(pet, { button: 0, pointerId: 9, screenX: 5, screenY: 5 })
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      fireEvent.pointerUp(pet, { pointerId: 9, screenX: 5, screenY: 5, clientX: 0, clientY: 0 })
      await Promise.resolve()
    })
    expect(mockEnqueueOneShot).toHaveBeenCalledWith("love")
    expect(bridgeSendInteraction).toHaveBeenCalledWith("petted")
  })

  it("ignores non-left pointer-down (right-click stays free)", async () => {
    withPet()
    render(<PetOverlayView />)
    const pet = screen.getByTestId("pet-overlay-pet")
    await act(async () => {
      fireEvent.pointerDown(pet, { button: 2, pointerId: 3, screenX: 0, screenY: 0 })
      await Promise.resolve()
    })
    expect(getPetWindowPosition).not.toHaveBeenCalled()
  })

  it("treats a missing window position as origin (0,0)", async () => {
    withPet()
    getPetWindowPosition.mockResolvedValue(null)
    render(<PetOverlayView />)
    const pet = screen.getByTestId("pet-overlay-pet")
    await act(async () => {
      fireEvent.pointerDown(pet, { button: 0, pointerId: 4, screenX: 0, screenY: 0 })
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => {
      fireEvent.pointerMove(pet, { pointerId: 4, screenX: 50, screenY: 60 })
      flushRaf()
    })
    expect(setPetWindowPosition).toHaveBeenCalledWith(50, 60)
  })

  it("cancels a still-pending rAF on pointer-up", async () => {
    withPet()
    render(<PetOverlayView />)
    const pet = screen.getByTestId("pet-overlay-pet")
    await act(async () => {
      fireEvent.pointerDown(pet, { button: 0, pointerId: 9, screenX: 0, screenY: 0 })
      await Promise.resolve()
      await Promise.resolve()
    })
    // Move (schedules a rAF) but DO NOT flush it before pointer-up.
    act(() => {
      fireEvent.pointerMove(pet, { pointerId: 9, screenX: 40, screenY: 40 })
    })
    await act(async () => {
      fireEvent.pointerUp(pet, { pointerId: 9, screenX: 40, screenY: 40 })
      await Promise.resolve()
    })
    expect(cancelRafSpy).toHaveBeenCalled()
    // base window (100,200) + delta (40,40)
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        petSettings: expect.objectContaining({
          desktopPet: expect.objectContaining({ position: { x: 140, y: 240, space: "desktop" } }),
        }),
      })
    )
  })

  it("does not persist when dragging but the window origin never resolved", () => {
    withPet()
    // Never resolves → winX/winY stay null.
    getPetWindowPosition.mockReturnValue(new Promise(() => {}))
    render(<PetOverlayView />)
    const pet = screen.getByTestId("pet-overlay-pet")
    act(() => {
      fireEvent.pointerDown(pet, { button: 0, pointerId: 10, screenX: 0, screenY: 0 })
    })
    act(() => {
      // Crosses threshold → dragging=true, but window origin unknown → skip move.
      fireEvent.pointerMove(pet, { pointerId: 10, screenX: 60, screenY: 60 })
    })
    act(() => {
      fireEvent.pointerUp(pet, { pointerId: 10, screenX: 60, screenY: 60 })
    })
    expect(setPetWindowPosition).not.toHaveBeenCalled()
    expect(saveMock).not.toHaveBeenCalled()
    // Was a drag, so no interaction either.
    expect(bridgeSendInteraction).not.toHaveBeenCalled()
  })

  it("ignores a pointer-up with no active drag (mismatched pointer)", () => {
    withPet()
    render(<PetOverlayView />)
    const pet = screen.getByTestId("pet-overlay-pet")
    act(() => {
      // Pointer-up with no prior pointer-down → dragRef is null → no-op.
      fireEvent.pointerUp(pet, { pointerId: 99, screenX: 0, screenY: 0 })
    })
    expect(bridgeSendInteraction).not.toHaveBeenCalled()
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("ignores moves for a different pointer id", async () => {
    withPet()
    render(<PetOverlayView />)
    const pet = screen.getByTestId("pet-overlay-pet")
    await act(async () => {
      fireEvent.pointerDown(pet, { button: 0, pointerId: 11, screenX: 0, screenY: 0 })
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => {
      // Different pointer id → ignored.
      fireEvent.pointerMove(pet, { pointerId: 77, screenX: 90, screenY: 90 })
      flushRaf()
    })
    expect(setPetWindowPosition).not.toHaveBeenCalled()
  })

  it("pointer-cancel for a different pointer id is ignored", async () => {
    withPet()
    render(<PetOverlayView />)
    const pet = screen.getByTestId("pet-overlay-pet")
    await act(async () => {
      fireEvent.pointerDown(pet, { button: 0, pointerId: 12, screenX: 0, screenY: 0 })
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => {
      fireEvent.pointerCancel(pet, { pointerId: 55, screenX: 0, screenY: 0 })
    })
    // The original drag ref still lives; a matching up still works.
    act(() => {
      fireEvent.pointerUp(pet, { pointerId: 12, screenX: 1, screenY: 1 })
    })
    expect(bridgeSendInteraction).toHaveBeenCalledWith("petted")
  })

  it("pointer-cancel with a pending rAF cancels it", async () => {
    withPet()
    render(<PetOverlayView />)
    const pet = screen.getByTestId("pet-overlay-pet")
    await act(async () => {
      fireEvent.pointerDown(pet, { button: 0, pointerId: 13, screenX: 0, screenY: 0 })
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => {
      fireEvent.pointerMove(pet, { pointerId: 13, screenX: 50, screenY: 50 })
      // do not flush; cancel while rAF pending
      fireEvent.pointerCancel(pet, { pointerId: 13, screenX: 50, screenY: 50 })
    })
    expect(cancelRafSpy).toHaveBeenCalled()
  })

  it("pointer-cancel aborts the drag without persisting", async () => {
    withPet()
    render(<PetOverlayView />)
    const pet = screen.getByTestId("pet-overlay-pet")
    await act(async () => {
      fireEvent.pointerDown(pet, { button: 0, pointerId: 5, screenX: 0, screenY: 0 })
      await Promise.resolve()
      await Promise.resolve()
    })
    act(() => {
      fireEvent.pointerMove(pet, { pointerId: 5, screenX: 80, screenY: 80 })
      fireEvent.pointerCancel(pet, { pointerId: 5, screenX: 80, screenY: 80 })
    })
    expect(saveMock).not.toHaveBeenCalled()
    expect(bridgeSendInteraction).not.toHaveBeenCalled()
  })

  describe("right-click popup", () => {
    it("opens the click popup anchored to the pet's own box", async () => {
      withPet()
      render(<PetOverlayView />)

      await act(async () => {
        fireEvent.contextMenu(screen.getByTestId("pet-overlay-root"))
        await Promise.resolve()
        await Promise.resolve()
      })

      // The sprite window never resizes/repositions for the menu — the popup
      // is its own window, placed natively against the pet's box.
      expect(setPetWindowPosition).not.toHaveBeenCalled()
      expect(openPetPopup).toHaveBeenCalledWith({
        width: POPUP_INITIAL_WIDTH,
        height: POPUP_INITIAL_HEIGHT,
        anchor: petBoxScreenRect({ x: 100, y: 200 }, 160, 1),
      })
    })

    it("scales the anchor by the monitor's factor on a 2x display", async () => {
      withPet()
      workAreaValue = { x: 0, y: 0, width: 3456, height: 2234, scaleFactor: 2 }
      render(<PetOverlayView />)
      await act(async () => {
        fireEvent.contextMenu(screen.getByTestId("pet-overlay-root"))
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(openPetPopup).toHaveBeenCalledWith(
        expect.objectContaining({ anchor: petBoxScreenRect({ x: 100, y: 200 }, 160, 2) })
      )
    })

    it("anchors the popup in points on a Retina Mac", async () => {
      withPet()
      mockIsMacOs = true
      workAreaValue = { x: 0, y: 25, width: 1512, height: 957, scaleFactor: 1 }
      Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true })
      render(<PetOverlayView />)
      await act(async () => {
        fireEvent.contextMenu(screen.getByTestId("pet-overlay-root"))
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(openPetPopup).toHaveBeenCalledWith(
        expect.objectContaining({ anchor: petBoxScreenRect({ x: 100, y: 200 }, 160, 1) })
      )
    })

    it("still opens with the pixel-ratio scale when the work area is unknown", async () => {
      withPet()
      workAreaValue = null
      Object.defineProperty(window, "devicePixelRatio", { value: 2, configurable: true })
      render(<PetOverlayView />)
      await act(async () => {
        fireEvent.contextMenu(screen.getByTestId("pet-overlay-root"))
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(openPetPopup).toHaveBeenCalledWith(
        expect.objectContaining({ anchor: petBoxScreenRect({ x: 100, y: 200 }, 160, 2) })
      )
    })

    it("does not open the popup when the window position can't be read", async () => {
      withPet()
      getPetWindowPosition.mockResolvedValue(null)
      render(<PetOverlayView />)
      await act(async () => {
        fireEvent.contextMenu(screen.getByTestId("pet-overlay-root"))
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(openPetPopup).not.toHaveBeenCalled()
    })

    it("a fast flick release hands off to beginThrow instead of persisting", async () => {
      withPet()
      render(<PetOverlayView />)
      const pet = screen.getByTestId("pet-overlay-pet")
      await act(async () => {
        fireEvent.pointerDown(pet, { button: 0, pointerId: 21, screenX: 0, screenY: 0 })
        await Promise.resolve()
        await Promise.resolve()
      })
      // Space the two move samples 100ms apart on the perf clock. React's
      // scheduler also reads performance.now(), so a fixed implementation per
      // phase (not mockReturnValueOnce) keeps the sample stamps deterministic.
      const nowSpy = jest.spyOn(performance, "now").mockImplementation(() => 1000)
      act(() => {
        fireEvent.pointerMove(pet, { pointerId: 21, screenX: 100, screenY: 0 })
      })
      nowSpy.mockImplementation(() => 1100)
      act(() => {
        fireEvent.pointerMove(pet, { pointerId: 21, screenX: 2100, screenY: 40 })
        flushRaf()
      })
      nowSpy.mockRestore()
      await act(async () => {
        fireEvent.pointerUp(pet, { pointerId: 21, screenX: 2100, screenY: 40 })
        await Promise.resolve()
      })
      // 2000px in 100ms → capped at MAX_RELEASE_SPEED ≥ MIN_THROW_SPEED → throw.
      expect(beginThrowMock).toHaveBeenCalledTimes(1)
      const [x, y, vx] = beginThrowMock.mock.calls[0] as [number, number, number, number]
      expect(x).toBe(100 + 2100)
      expect(y).toBe(200 + 40)
      expect(vx).toBeGreaterThan(0)
      expect(saveMock).not.toHaveBeenCalled()
      expect(settleAtMock).not.toHaveBeenCalled()
    })

    it("hands a throw desktop-pixel velocity on a 2x Windows display", async () => {
      withPet()
      workAreaValue = { x: 0, y: 0, width: 3456, height: 2234, scaleFactor: 2 }
      render(<PetOverlayView />)
      const pet = screen.getByTestId("pet-overlay-pet")
      await act(async () => {
        fireEvent.pointerDown(pet, { button: 0, pointerId: 22, screenX: 0, screenY: 0 })
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
      })
      const nowSpy = jest.spyOn(performance, "now").mockImplementation(() => 1000)
      act(() => {
        fireEvent.pointerMove(pet, { pointerId: 22, screenX: 100, screenY: 0 })
      })
      nowSpy.mockImplementation(() => 1100)
      act(() => {
        fireEvent.pointerMove(pet, { pointerId: 22, screenX: 200, screenY: 0 })
        flushRaf()
      })
      nowSpy.mockRestore()
      await act(async () => {
        fireEvent.pointerUp(pet, { pointerId: 22, screenX: 200, screenY: 0 })
        await Promise.resolve()
      })
      // 100 CSS px in 100ms = 1000 CSS px/s: a throw by feel, and 2000 px/s in
      // the physical space the ballistics run in.
      expect(beginThrowMock).toHaveBeenCalledTimes(1)
      const [x, , vx] = beginThrowMock.mock.calls[0] as [number, number, number, number]
      expect(x).toBe(100 + 200 * 2)
      expect(vx).toBeCloseTo(2000)
    })

    it("wires pause signals + settle persistence into the locomotion hook", async () => {
      withPet()
      bubbleValue = { text: "hi", origin: "system" }
      render(<PetOverlayView />)
      const args = locomotionArgs.mock.calls.at(-1)![0] as {
        paused: boolean
        enabled: boolean
        petSize: number
        onSettle: (x: number, y: number) => void
      }
      // A visible bubble pauses wandering.
      expect(args.paused).toBe(true)
      expect(args.enabled).toBe(true)
      expect(args.petSize).toBe(160)
      // Settling persists through the live settings snapshot.
      await act(async () => {
        args.onSettle(111, 222)
        await Promise.resolve()
      })
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          petSettings: expect.objectContaining({
            desktopPet: expect.objectContaining({
              position: { x: 111, y: 222, space: "desktop" },
            }),
          }),
        })
      )
    })

    it("passes locomotion + hidden-paused to the renderer", () => {
      withPet()
      render(<PetOverlayView />)
      expect(rendererProps).toHaveBeenCalledWith(
        expect.objectContaining({
          locomotion: { mode: "resting", facing: "right" },
          paused: false,
        })
      )
    })
  })
})
