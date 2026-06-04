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

// Quick-menu wiring deps.
const routerPush = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }))

const saveMock = jest.fn().mockResolvedValue(undefined)
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: { save: unknown }) => unknown) => selector({ save: saveMock }),
}))

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
import { PetWidget } from "./pet-widget"
import { usePetStore } from "@/stores/pet/pet-store"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import { DEFAULT_PET_DESKTOP_OVERLAY, DEFAULT_PET_SETTINGS, type PetProfile } from "@/types/pet"

const mockUsePet = usePet as jest.Mock

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
  usePetStore.setState({ visualState: "idle", oneShotQueue: [], bubble: null, minimized: false })
  routerPush.mockReset()
  saveMock.mockClear()
  openPetWindow.mockClear()
  closePetWindow.mockClear()
  isPetWindowOpen.mockClear()
  mockTauri = true
  petWindowOpen = false
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
})
