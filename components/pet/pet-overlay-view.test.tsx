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
  PetBubbleView: ({ bubble }: { bubble: { text: string } | null }) =>
    bubble ? <div data-testid="pet-bubble">{bubble.text}</div> : null,
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
let workAreaValue: unknown = { x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1 }
jest.mock("@/lib/tauri/pet-window", () => ({
  getPetWindowPosition: () => getPetWindowPosition(),
  setPetWindowPosition: (x: number, y: number) => setPetWindowPosition(x, y),
  getPetWorkArea: () => Promise.resolve(workAreaValue),
  openPetPopup: (opts: unknown) => openPetPopup(opts),
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

// Tauri window API used by the post-paint reveal effect (dynamic import).
const revealShowMock = jest.fn().mockResolvedValue(undefined)
const revealInnerSizeMock = jest.fn().mockResolvedValue({ width: 200, height: 240 })
const revealSetSizeMock = jest.fn().mockResolvedValue(undefined)
const revealSetResizableMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    show: revealShowMock,
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
jest.mock("@/hooks/pet/use-pet-locomotion", () => ({
  usePetLocomotion: (args: unknown) => {
    locomotionArgs(args)
    return {
      locomotion: { mode: "resting", facing: "right" },
      scaleFactor: 1,
      beginThrow: beginThrowMock,
    }
  },
}))

// Pet store bubble selector.
let bubbleValue: { text: string; origin: string } | null = null
const mockEnqueueOneShot = jest.fn()
jest.mock("@/stores/pet/pet-store", () => ({
  usePetStore: Object.assign(
    (selector: (s: { bubble: unknown }) => unknown) => selector({ bubble: bubbleValue }),
    { getState: () => ({ enqueueOneShot: mockEnqueueOneShot }) }
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

import { PetOverlayView } from "./pet-overlay-view"
import {
  POPUP_INITIAL_HEIGHT,
  POPUP_INITIAL_WIDTH,
  resolvePopupPlacement,
} from "@/lib/pet/popup-geometry"
import { overlayWindowSize } from "@/lib/pet/overlay-geometry"

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
    withPet()
    await act(async () => {
      render(<PetOverlayView />)
    })
    // Not shown until BOTH rAFs (layout + post-commit) have run.
    expect(revealShowMock).not.toHaveBeenCalled()
    await act(async () => {
      flushRaf() // rAF #1 schedules rAF #2
    })
    expect(revealShowMock).not.toHaveBeenCalled()
    await act(async () => {
      flushRaf() // rAF #2 runs reveal (dynamic import + show)
    })
    expect(revealShowMock).toHaveBeenCalledTimes(1)
    // Nudge the physical size by 1px then restore it, to force the transparent
    // surface to recomposite (the Windows black-until-resize quirk). Resizing is
    // briefly enabled so the non-resizable window doesn't clamp the nudge.
    expect(revealSetResizableMock).toHaveBeenNthCalledWith(1, true)
    expect(revealSetSizeMock).toHaveBeenCalledTimes(2)
    expect(revealSetSizeMock.mock.calls[0][0]).toMatchObject({ width: 200, height: 241 })
    expect(revealSetSizeMock.mock.calls[1][0]).toMatchObject({ width: 200, height: 240 })
    expect(revealSetResizableMock).toHaveBeenNthCalledWith(2, false)
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
          desktopPet: expect.objectContaining({ position: { x: 140, y: 230 } }),
        }),
      })
    )
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
          desktopPet: expect.objectContaining({ position: { x: 140, y: 240 } }),
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
    it("opens the click popup window with a resolved on-screen placement", async () => {
      withPet()
      render(<PetOverlayView />)

      await act(async () => {
        fireEvent.contextMenu(screen.getByTestId("pet-overlay-root"))
        await Promise.resolve()
        await Promise.resolve()
      })

      // The sprite window never resizes/repositions for the menu anymore — the
      // popup is its own window opened at the resolved size + clamped coords.
      expect(setPetWindowPosition).not.toHaveBeenCalled()
      expect(openPetPopup).toHaveBeenCalledTimes(1)
      const opts = openPetPopup.mock.calls[0][0] as {
        width: number
        height: number
        x: number
        y: number
      }
      expect(opts.width).toBe(POPUP_INITIAL_WIDTH)
      expect(opts.height).toBe(POPUP_INITIAL_HEIGHT)
      // Placement matches the pure geometry: sprite window rect (pos 100,200,
      // logical box for size 160, scale 1) + the 1920x1080 work area.
      const logical = overlayWindowSize(160)
      const expected = resolvePopupPlacement(
        { x: 100, y: 200, width: logical.width, height: logical.height },
        { width: POPUP_INITIAL_WIDTH, height: POPUP_INITIAL_HEIGHT },
        { x: 0, y: 0, width: 1920, height: 1080 }
      )
      expect(opts.x).toBe(expected.x)
      expect(opts.y).toBe(expected.y)
    })

    it("does not open the popup when the work area can't be resolved", async () => {
      withPet()
      workAreaValue = null
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
            desktopPet: expect.objectContaining({ position: { x: 111, y: 222 } }),
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
