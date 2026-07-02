/**
 * @jest-environment jsdom
 */
import "@/components/interactions/test-pointer-polyfill"
import { render, screen, fireEvent, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/hooks/pet/use-pet")
jest.mock("@/hooks/pet/use-pet-bubbles", () => ({ usePetBubbles: jest.fn() }))
// Default: no active Live2D model, so the widget renders the SVG skin.
jest.mock("@/hooks/pet/use-active-live2d-model", () => ({
  useActiveLive2dModel: jest.fn(() => ({ modelId: undefined, row: undefined, coreReady: false })),
}))

// Stub the interaction panel so the widget's resolved preview skin is
// observable without mounting the live2d skin (stores + canvas).
jest.mock("./pet-interaction-panel", () => ({
  PetInteractionPanel: ({ skinId }: { skinId?: string }) => (
    <div data-testid="pet-interaction-panel" data-skin={skinId ?? "default"} />
  ),
}))

// Quick-menu wiring deps.
const routerPush = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }))

const saveMock = jest.fn().mockResolvedValue(undefined)
// `toggleDesktopPetWindow` (in lib/pet/commands.ts, exercised for real by the
// desktop-pet toggle tests below) reads the live snapshot via
// `useSettingsStore.getState()`, not the `settings` prop PetWidget itself
// renders from — so the mock needs both the hook-selector form AND a
// `.getState()` static, kept in sync with `settingsValue` (mirrors the same
// pattern in pet-overlay-view.test.tsx).
let settingsValue: unknown = {}
jest.mock("@/stores/settings", () => {
  const useSettingsStore = (selector: (s: { save: unknown; settings: unknown }) => unknown) =>
    selector({ save: saveMock, settings: settingsValue })
  useSettingsStore.getState = () => ({ save: saveMock, settings: settingsValue })
  return { useSettingsStore }
})

// `var` (not `let`/`const`): lib/tauri's transport picker calls isTauri() while
// the test module's import graph is still evaluating — before a `let` would
// initialize — so only a hoisted `var` is reachable from the mock factory.
// Keep every other detect export real (the picker also calls isCapacitor()).
// eslint-disable-next-line no-var
var mockTauri = true
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => mockTauri,
}))

// Throw physics — deep-tested on its own (`use-pet-widget-throw.test.ts`);
// here we only record the wiring args and surface controllable spies, mirroring
// how the overlay's test mocks `usePetLocomotion`. The drag-vs-tap gesture hook
// stays real so pointer-event sequences exercise the actual state machine.
const beginThrowMock = jest.fn()
const setOffsetImmediateMock = jest.fn()
let widgetThrowOffset = { x: 0, y: 0 }
let widgetThrowArgs: {
  onSettle?: (x: number, y: number) => void
} = {}
jest.mock("@/hooks/pet/use-pet-widget-throw", () => ({
  usePetWidgetThrow: (args: { onSettle?: (x: number, y: number) => void }) => {
    widgetThrowArgs = args
    return {
      offset: widgetThrowOffset,
      isThrowing: false,
      beginThrow: beginThrowMock,
      setOffsetImmediate: setOffsetImmediateMock,
    }
  },
}))

const openPetWindow = jest.fn().mockResolvedValue(true)
const closePetWindow = jest.fn().mockResolvedValue(true)
let petWindowOpen = false
const isPetWindowOpen = jest.fn(() => Promise.resolve(petWindowOpen))
jest.mock("@/lib/tauri/pet-window", () => ({
  openPetWindow: (...a: unknown[]) => openPetWindow(...a),
  closePetWindow: () => closePetWindow(),
  isPetWindowOpen: () => isPetWindowOpen(),
}))

import { usePet } from "@/hooks/pet/use-pet"
import { useActiveLive2dModel } from "@/hooks/pet/use-active-live2d-model"
import { PetWidget } from "./pet-widget"
import { usePetStore } from "@/stores/pet/pet-store"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import { DEFAULT_PET_DESKTOP_OVERLAY, DEFAULT_PET_SETTINGS, type PetProfile } from "@/types/pet"

const mockUsePet = usePet as jest.Mock
const mockUseActiveLive2dModel = useActiveLive2dModel as jest.Mock

function withPet() {
  const profile: PetProfile = {
    ...createDefaultProfile("acct-1", 0),
    soul: { name: "Boba", personality: "x", hatchDate: "" },
    stage: "baby",
  }
  mockUsePet.mockReturnValue({
    profile,
    view: computePetView(profile, null, 0),
    loading: false,
    feed: jest.fn(),
    play: jest.fn(),
    petStroke: jest.fn(),
    talk: jest.fn(),
  })
}

beforeEach(() => {
  mockUsePet.mockReset()
  mockUseActiveLive2dModel.mockReset()
  // Default: no active Live2D model → the widget resolves to the SVG skin.
  mockUseActiveLive2dModel.mockReturnValue({ modelId: undefined, row: undefined, coreReady: false })
  usePetStore.setState({
    visualState: "idle",
    oneShotQueue: [],
    bubble: null,
    minimized: false,
    position: null,
  })
  routerPush.mockReset()
  saveMock.mockClear()
  settingsValue = {}
  openPetWindow.mockClear()
  closePetWindow.mockClear()
  isPetWindowOpen.mockClear()
  mockTauri = true
  petWindowOpen = false
  beginThrowMock.mockClear()
  setOffsetImmediateMock.mockClear()
  widgetThrowOffset = { x: 0, y: 0 }
  widgetThrowArgs = {}
})

describe("PetWidget", () => {
  it("renders nothing until the pet loads", () => {
    mockUsePet.mockReturnValue({
      profile: undefined,
      view: undefined,
      loading: true,
      feed() {},
      play() {},
      petStroke() {},
      talk() {},
    })
    const { container } = render(<PetWidget settings={DEFAULT_PET_SETTINGS} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders the pet and toggles the interaction panel on click", () => {
    withPet()
    render(<PetWidget settings={DEFAULT_PET_SETTINGS} />)
    expect(document.querySelector('[data-pet-skin-root="svg"]')).not.toBeNull()
    expect(screen.queryByTestId("pet-interaction-panel")).toBeNull()
    fireEvent.click(screen.getByTestId("pet-handle"))
    expect(screen.getByTestId("pet-interaction-panel")).toBeInTheDocument()
  })

  it("passes the resolved Live2D skin to the interaction panel when active + ready", () => {
    withPet()
    mockUseActiveLive2dModel.mockReturnValue({ modelId: "m1", row: undefined, coreReady: true })
    render(<PetWidget settings={{ ...DEFAULT_PET_SETTINGS, skinId: "live2d" }} />)
    fireEvent.click(screen.getByTestId("pet-handle"))
    expect(screen.getByTestId("pet-interaction-panel").dataset.skin).toBe("live2d")
  })

  it("renders the unwell visual from the decayed care condition even while the store rests", () => {
    // Store visual state is a benign resting `idle`, but the lazily-decayed view
    // reports an unwell pet — the widget must overlay it immediately.
    const profile: PetProfile = {
      ...createDefaultProfile("acct-unwell", 0),
      soul: { name: "Boba", personality: "x", hatchDate: "" },
      stage: "baby",
      needs: { energy: 8, mood: 8, bond: 40, lastTickAt: new Date(0).toISOString() },
      care: {
        lowSince: -1,
        condition: "unwell",
        notifiedAt: null,
        everUnwell: true,
        careQuality: 20,
      },
    }
    mockUsePet.mockReturnValue({
      profile,
      view: computePetView(profile, null, 0),
      loading: false,
      feed: jest.fn(),
      play: jest.fn(),
      petStroke: jest.fn(),
      talk: jest.fn(),
    })
    usePetStore.setState({ visualState: "idle" })
    render(<PetWidget settings={DEFAULT_PET_SETTINGS} />)
    expect(document.querySelector('[data-pet-state="unwell"]')).not.toBeNull()
  })

  it("minimizes to a restore handle and back", () => {
    withPet()
    render(<PetWidget settings={DEFAULT_PET_SETTINGS} />)
    fireEvent.click(screen.getByLabelText(/minimize|widget\.minimize/i))
    expect(screen.getByTestId("pet-restore")).toBeInTheDocument()
    act(() => {
      fireEvent.click(screen.getByTestId("pet-restore"))
    })
    expect(screen.getByTestId("pet-handle")).toBeInTheDocument()
  })

  it("keeps the restore icon centered — anchor alignment must not leak into the circle", () => {
    withPet()
    usePetStore.setState({ minimized: true })
    render(<PetWidget settings={{ ...DEFAULT_PET_SETTINGS, anchor: "bottom-right" }} />)
    const restore = screen.getByTestId("pet-restore")
    expect(restore.className).toContain("items-center")
    expect(restore.className).not.toMatch(/items-end|items-start/)
  })

  it("right-click opens the widget quick menu and routes to the pet console", async () => {
    const user = userEvent.setup()
    withPet()
    render(<PetWidget settings={DEFAULT_PET_SETTINGS} />)
    fireEvent.contextMenu(screen.getByTestId("pet-handle"))
    await user.click(screen.getByText("Open pet panel"))
    expect(routerPush).toHaveBeenCalledWith("/pet")
  })

  it("quick menu routes to pet settings and minimizes", async () => {
    const user = userEvent.setup()
    withPet()
    render(<PetWidget settings={DEFAULT_PET_SETTINGS} />)
    fireEvent.contextMenu(screen.getByTestId("pet-handle"))
    await user.click(screen.getByText("Open settings"))
    expect(routerPush).toHaveBeenCalledWith("/settings?section=pet")

    fireEvent.contextMenu(screen.getByTestId("pet-handle"))
    await user.click(screen.getByText("Minimize"))
    expect(screen.getByTestId("pet-restore")).toBeInTheDocument()
  })

  it("quick menu feed/play/pet/talk call the usePet actions", async () => {
    const user = userEvent.setup()
    const feed = jest.fn()
    const play = jest.fn()
    const petStroke = jest.fn()
    const talk = jest.fn()
    const profile: PetProfile = {
      ...createDefaultProfile("acct-1", 0),
      soul: { name: "Boba", personality: "x", hatchDate: "" },
      stage: "baby",
    }
    mockUsePet.mockReturnValue({
      profile,
      view: computePetView(profile, null, 0),
      loading: false,
      feed,
      play,
      petStroke,
      talk,
    })
    render(<PetWidget settings={DEFAULT_PET_SETTINGS} />)
    fireEvent.contextMenu(screen.getByTestId("pet-handle"))
    await user.click(screen.getByText("Feed"))
    expect(feed).toHaveBeenCalledTimes(1)
  })

  it("opens the desktop pet window and persists enabled when toggled on", async () => {
    const user = userEvent.setup()
    withPet()
    petWindowOpen = false
    settingsValue = {
      petSettings: { ...DEFAULT_PET_SETTINGS, desktopPet: DEFAULT_PET_DESKTOP_OVERLAY },
    }
    render(
      <PetWidget settings={{ ...DEFAULT_PET_SETTINGS, desktopPet: DEFAULT_PET_DESKTOP_OVERLAY }} />
    )
    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId("pet-handle"))
      await Promise.resolve()
    })
    await user.click(screen.getByText("Show desktop pet"))
    expect(openPetWindow).toHaveBeenCalledWith(
      expect.objectContaining({ width: 128 + 96, height: 128 + 160, clickThrough: false })
    )
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        petSettings: expect.objectContaining({
          desktopPet: expect.objectContaining({ enabled: true }),
        }),
      })
    )
  })

  it("closes the desktop pet window and persists disabled when already open", async () => {
    const user = userEvent.setup()
    withPet()
    petWindowOpen = true
    settingsValue = {
      petSettings: { ...DEFAULT_PET_SETTINGS, desktopPet: DEFAULT_PET_DESKTOP_OVERLAY },
    }
    render(
      <PetWidget settings={{ ...DEFAULT_PET_SETTINGS, desktopPet: DEFAULT_PET_DESKTOP_OVERLAY }} />
    )
    await act(async () => {
      fireEvent.contextMenu(screen.getByTestId("pet-handle"))
      // resolve the isPetWindowOpen() probe so the label reads "Hide desktop pet"
      await Promise.resolve()
      await Promise.resolve()
    })
    await user.click(screen.getByText("Hide desktop pet"))
    expect(closePetWindow).toHaveBeenCalledTimes(1)
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        petSettings: expect.objectContaining({
          desktopPet: expect.objectContaining({ enabled: false }),
        }),
      })
    )
  })

  it("hides the desktop-pet toggle off Tauri", () => {
    mockTauri = false
    withPet()
    render(<PetWidget settings={DEFAULT_PET_SETTINGS} />)
    fireEvent.contextMenu(screen.getByTestId("pet-handle"))
    expect(screen.queryByText("Show desktop pet")).toBeNull()
    expect(screen.queryByText("Hide desktop pet")).toBeNull()
  })

  describe("drag + throw physics", () => {
    let rafSpy: jest.SpyInstance
    let cancelRafSpy: jest.SpyInstance
    const rafCallbacks: FrameRequestCallback[] = []

    beforeEach(() => {
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

    it("a tap enqueues a zone-specific one-shot, opens the panel, and grants no XP", () => {
      const petStroke = jest.fn()
      const profile: PetProfile = {
        ...createDefaultProfile("acct-1", 0),
        soul: { name: "Boba", personality: "x", hatchDate: "" },
        stage: "baby",
      }
      mockUsePet.mockReturnValue({
        profile,
        view: computePetView(profile, null, 0),
        loading: false,
        feed: jest.fn(),
        play: jest.fn(),
        petStroke,
        talk: jest.fn(),
      })
      render(<PetWidget settings={DEFAULT_PET_SETTINGS} />)
      const handle = screen.getByTestId("pet-handle")
      // The real `usePetAnimationState` hook drains `oneShotQueue` almost
      // immediately (that's its job), so asserting on the queue snapshot
      // after `act()` is racy — spy on the store action itself instead.
      const enqueueSpy = jest.spyOn(usePetStore.getState(), "enqueueOneShot")
      act(() => {
        // clientY 0 → top band → "head" zone → "love" reaction (jsdom rect is
        // 0×0, so local coords equal the client coords).
        fireEvent.pointerDown(handle, { button: 0, pointerId: 1, screenX: 5, screenY: 5 })
        fireEvent.pointerUp(handle, {
          pointerId: 1,
          screenX: 5,
          screenY: 5,
          clientX: 0,
          clientY: 0,
        })
      })
      expect(enqueueSpy).toHaveBeenCalledWith("love")
      expect(screen.getByTestId("pet-interaction-panel")).toBeInTheDocument()
      expect(petStroke).not.toHaveBeenCalled()
      expect(beginThrowMock).not.toHaveBeenCalled()
      expect(setOffsetImmediateMock).not.toHaveBeenCalled()
      enqueueSpy.mockRestore()
    })

    it("dragging beyond the threshold offsets the handle and persists on a slow release", () => {
      withPet()
      render(<PetWidget settings={DEFAULT_PET_SETTINGS} />)
      const handle = screen.getByTestId("pet-handle")
      act(() => {
        fireEvent.pointerDown(handle, { button: 0, pointerId: 2, screenX: 0, screenY: 0 })
        fireEvent.pointerMove(handle, { pointerId: 2, screenX: 40, screenY: 30 })
        flushRaf()
      })
      expect(setOffsetImmediateMock).toHaveBeenCalledWith(40, 30)
      act(() => {
        fireEvent.pointerUp(handle, { pointerId: 2, screenX: 40, screenY: 30 })
      })
      expect(usePetStore.getState().position).toEqual({ x: 40, y: 30 })
      expect(beginThrowMock).not.toHaveBeenCalled()
    })

    it("a fast flick hands off to beginThrow instead of persisting immediately", () => {
      withPet()
      render(<PetWidget settings={DEFAULT_PET_SETTINGS} />)
      const handle = screen.getByTestId("pet-handle")
      act(() => {
        fireEvent.pointerDown(handle, { button: 0, pointerId: 3, screenX: 0, screenY: 0 })
      })
      const nowSpy = jest.spyOn(performance, "now").mockImplementation(() => 1000)
      act(() => {
        fireEvent.pointerMove(handle, { pointerId: 3, screenX: 100, screenY: 0 })
      })
      nowSpy.mockImplementation(() => 1100)
      act(() => {
        fireEvent.pointerMove(handle, { pointerId: 3, screenX: 2100, screenY: 40 })
        flushRaf()
      })
      nowSpy.mockRestore()
      act(() => {
        fireEvent.pointerUp(handle, { pointerId: 3, screenX: 2100, screenY: 40 })
      })
      expect(beginThrowMock).toHaveBeenCalledTimes(1)
      const [vx] = beginThrowMock.mock.calls[0] as [number, number]
      expect(vx).toBeGreaterThan(0)
      // Persistence happens later, from the settle callback — not synchronously.
      expect(usePetStore.getState().position).toBeNull()
    })

    it("wires onSettle to persist the resting offset", () => {
      withPet()
      render(<PetWidget settings={DEFAULT_PET_SETTINGS} />)
      act(() => {
        widgetThrowArgs.onSettle?.(77, -12)
      })
      expect(usePetStore.getState().position).toEqual({ x: 77, y: -12 })
    })
  })
})
