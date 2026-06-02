import { render, screen, fireEvent, act } from "@testing-library/react"

jest.mock("@/hooks/pet/use-pet")
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (s: (x: unknown) => unknown) => s({ settings: {} }),
}))
jest.mock("@/lib/ai/generation/utility-client", () => ({ buildUtilityLlmClient: () => null }))
const hatchPet = jest.fn().mockResolvedValue(undefined)
const emitPetEvent = jest.fn()
jest.mock("@/lib/pet/runtime/init-pet", () => ({ hatchPet: () => hatchPet() }))
jest.mock("@/lib/pet/events/pet-event-bus", () => ({ emitPetEvent: () => emitPetEvent() }))
jest.mock("./dex-tab", () => ({ DexTab: () => <div data-testid="tab-dex" /> }))
jest.mock("./achievements-tab", () => ({ AchievementsTab: () => <div data-testid="tab-ach" /> }))
jest.mock("./binding-tab", () => ({ BindingTab: () => <div data-testid="tab-bind" /> }))

import { usePet } from "@/hooks/pet/use-pet"
import { PetConsole } from "./pet-console"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import type { PetProfile } from "@/types/pet"

const mockUsePet = usePet as jest.Mock

function petResult(soul: PetProfile["soul"]) {
  const profile: PetProfile = {
    ...createDefaultProfile("acct-1", 0),
    soul,
    stage: soul ? "baby" : "egg",
  }
  return {
    profile,
    view: computePetView(profile, null, 0),
    loading: false,
    feed: jest.fn(),
    play: jest.fn(),
    petStroke: jest.fn(),
    talk: jest.fn(),
  }
}

beforeEach(() => {
  mockUsePet.mockReset()
  hatchPet.mockClear()
  emitPetEvent.mockClear()
})

describe("PetConsole", () => {
  it("shows loading until the pet is ready", () => {
    mockUsePet.mockReturnValue({ profile: undefined, view: undefined, loading: true })
    render(<PetConsole />)
    expect(screen.getByTestId("pet-console-loading")).toBeInTheDocument()
  })

  it("offers a hatch action for an unhatched egg", async () => {
    mockUsePet.mockReturnValue(petResult(null))
    render(<PetConsole />)
    expect(screen.getByTestId("pet-hatch")).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /hatch|console\.hatch/i }))
    })
    expect(hatchPet).toHaveBeenCalled()
    expect(emitPetEvent).toHaveBeenCalled()
  })

  it("shows the interaction panel for a hatched pet and switches tabs", () => {
    mockUsePet.mockReturnValue(petResult({ name: "Boba", personality: "x", hatchDate: "" }))
    render(<PetConsole />)
    expect(screen.getByTestId("pet-interaction-panel")).toBeInTheDocument()
    const clickTab = (id: string) =>
      fireEvent.click(document.querySelector(`[data-tab="${id}"]`) as Element)
    clickTab("dex")
    expect(screen.getByTestId("tab-dex")).toBeInTheDocument()
    clickTab("achievements")
    expect(screen.getByTestId("tab-ach")).toBeInTheDocument()
    clickTab("binding")
    expect(screen.getByTestId("tab-bind")).toBeInTheDocument()
  })
})
