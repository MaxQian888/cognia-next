import { render, screen, fireEvent, act } from "@testing-library/react"

jest.mock("@/hooks/pet/use-pet")
jest.mock("@/hooks/pet/use-pet-bubbles", () => ({ usePetBubbles: jest.fn() }))

import { usePet } from "@/hooks/pet/use-pet"
import { PetWidget } from "./pet-widget"
import { usePetStore } from "@/stores/pet/pet-store"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import { DEFAULT_PET_SETTINGS, type PetProfile } from "@/types/pet"

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
})
