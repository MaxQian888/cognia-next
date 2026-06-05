/**
 * @jest-environment jsdom
 */
import "@/components/interactions/test-pointer-polyfill"
import { render, screen, act, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("motion/react", () => ({
  useReducedMotion: () => false,
}))

// Pet read model.
const mockUsePet = jest.fn()
jest.mock("@/hooks/pet/use-pet", () => ({ usePet: (id?: string | null) => mockUsePet(id) }))

// One-shot animation hook → static state for the renderer.
jest.mock("@/hooks/pet/use-pet-animation-state", () => ({
  usePetAnimationState: () => ({ state: "idle", oneShot: null }),
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
jest.mock("@/hooks/pet/use-active-live2d-model", () => ({
  useActiveLive2dModel: () => useActiveLive2dModel(),
}))

// Tauri window wrappers.
const getPetWindowPosition = jest.fn()
const setPetWindowPosition = jest.fn()
const resizePetWindow = jest.fn()
const setPetClickThrough = jest.fn()
const closePetWindow = jest.fn()
const showMainWindow = jest.fn()
jest.mock("@/lib/tauri/pet-window", () => ({
  getPetWindowPosition: () => getPetWindowPosition(),
  setPetWindowPosition: (x: number, y: number) => setPetWindowPosition(x, y),
  resizePetWindow: (w: number, h: number) => resizePetWindow(w, h),
  setPetClickThrough: (v: boolean) => setPetClickThrough(v),
  closePetWindow: () => closePetWindow(),
  showMainWindow: () => showMainWindow(),
  getPetWorkArea: () => Promise.resolve(null),
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
jest.mock("@/stores/pet/pet-store", () => ({
  usePetStore: (selector: (s: { bubble: unknown }) => unknown) => selector({ bubble: bubbleValue }),
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

const PROFILE = { stage: "baby" }
const VIEW = { effectiveBones: { eyes: "dot" } }

function withPet() {
  mockUsePet.mockReturnValue({ profile: PROFILE, view: VIEW, loading: false })
}

let rafSpy: jest.SpyInstance
let cancelRafSpy: jest.SpyInstance
const rafCallbacks: FrameRequestCallback[] = []

beforeEach(() => {
  mockUsePet.mockReset()
  rendererProps.mockReset()
  bridgeDispose.mockReset()
  bridgeSendInteraction.mockReset()
  startOverlayPetBridge.mockClear()
  getPetWindowPosition.mockReset()
  getPetWindowPosition.mockResolvedValue({ x: 100, y: 200 })
  setPetWindowPosition.mockReset()
  setPetWindowPosition.mockResolvedValue(true)
  resizePetWindow.mockReset()
  resizePetWindow.mockResolvedValue(true)
  setPetClickThrough.mockReset()
  setPetClickThrough.mockResolvedValue(true)
  closePetWindow.mockReset()
  closePetWindow.mockResolvedValue(true)
  showMainWindow.mockReset()
  showMainWindow.mockResolvedValue(true)
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

  describe("quick menu", () => {
    function openMenu() {
      fireEvent.contextMenu(screen.getByTestId("pet-overlay-root"))
    }

    it("right-click feed/play send the matching interaction over the bridge", async () => {
      const user = userEvent.setup()
      withPet()
      render(<PetOverlayView />)

      openMenu()
      await user.click(screen.getByText("feed"))
      expect(bridgeSendInteraction).toHaveBeenCalledWith("fed")

      openMenu()
      await user.click(screen.getByText("play"))
      expect(bridgeSendInteraction).toHaveBeenCalledWith("played")
    })

    it("right-click talk opens the composer; submit rides the bridge with text", async () => {
      const user = userEvent.setup()
      withPet()
      render(<PetOverlayView />)

      openMenu()
      await user.click(screen.getByText("talk"))
      // Menu talk opens the composer instead of firing a bare interaction.
      expect(bridgeSendInteraction).not.toHaveBeenCalledWith("talked")
      const input = screen.getByLabelText("talkPlaceholder")
      fireEvent.change(input, { target: { value: "hi pet" } })
      fireEvent.keyDown(input, { key: "Enter" })
      expect(bridgeSendInteraction).toHaveBeenCalledWith("talked", "hi pet")
      // Composer closes after submit.
      expect(screen.queryByTestId("pet-overlay-talk-composer")).not.toBeInTheDocument()
    })

    it("escape closes the composer without sending", async () => {
      const user = userEvent.setup()
      withPet()
      render(<PetOverlayView />)

      openMenu()
      await user.click(screen.getByText("talk"))
      const input = screen.getByLabelText("talkPlaceholder")
      fireEvent.keyDown(input, { key: "Escape" })
      expect(screen.queryByTestId("pet-overlay-talk-composer")).not.toBeInTheDocument()
      expect(bridgeSendInteraction).not.toHaveBeenCalled()
    })

    it("click-through turns on the OS flag and persists clickThrough=true", async () => {
      const user = userEvent.setup()
      withPet()
      render(<PetOverlayView />)
      openMenu()
      await user.click(screen.getByText("clickThrough"))
      expect(setPetClickThrough).toHaveBeenCalledWith(true)
      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          petSettings: expect.objectContaining({
            desktopPet: expect.objectContaining({ clickThrough: true }),
          }),
        })
      )
    })

    it("hide desktop pet closes the window; show main window restores the app", async () => {
      const user = userEvent.setup()
      withPet()
      render(<PetOverlayView />)

      openMenu()
      await user.click(screen.getByText("hideDesktopPet"))
      expect(closePetWindow).toHaveBeenCalledTimes(1)

      openMenu()
      await user.click(screen.getByText("showMainWindow"))
      expect(showMainWindow).toHaveBeenCalledTimes(1)
    })

    it("grows the window upward on open and restores the chrome-inclusive box on close", async () => {
      withPet()
      render(<PetOverlayView />)
      // size 160 from the default beforeEach settings; the resting window box
      // always carries the chrome margins (96 / 160) — restoring to the bare
      // pet size used to shed them after the first menu open (regression).
      // The grow is asynchronous (reads the position first to compensate).
      await act(async () => {
        openMenu()
        await Promise.resolve()
      })
      expect(resizePetWindow).toHaveBeenCalledWith(160 + 96, 160 + 160 + 240)
      // Upward growth: window shifted up by the grow so the pet stays put.
      expect(setPetWindowPosition).toHaveBeenCalledWith(100, 200 - 240)

      // Close (Escape) → restore to the chrome-inclusive resting box + shift back.
      setPetWindowPosition.mockClear()
      await act(async () => {
        fireEvent.keyDown(document.activeElement || document.body, { key: "Escape" })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(resizePetWindow).toHaveBeenCalledWith(160 + 96, 160 + 160)
      expect(setPetWindowPosition).toHaveBeenCalledWith(100, 200 + 240)
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
