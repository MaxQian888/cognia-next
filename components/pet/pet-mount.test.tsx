import { render } from "@testing-library/react"

const usePetEventBus = jest.fn()
const ensurePetAccountId = jest.fn().mockResolvedValue("acct-1")
const ensurePetProfile = jest.fn().mockResolvedValue(undefined)

jest.mock("@/hooks/pet/use-pet-event-bus", () => ({
  usePetEventBus: (e: boolean) => usePetEventBus(e),
}))
jest.mock("@/lib/pet/bones/account-id", () => ({ ensurePetAccountId: () => ensurePetAccountId() }))
jest.mock("@/lib/pet/runtime/init-pet", () => ({ ensurePetProfile: () => ensurePetProfile() }))
jest.mock("./pet-widget", () => ({ PetWidget: () => <div data-testid="pet-widget" /> }))

let settingsValue: unknown = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: settingsValue, save: jest.fn() }),
}))

import { PetMount } from "./pet-mount"

beforeEach(() => {
  usePetEventBus.mockClear()
  ensurePetAccountId.mockClear()
  ensurePetProfile.mockClear()
})

describe("PetMount", () => {
  it("renders nothing and stays disabled when pet is off", () => {
    settingsValue = {
      petSettings: {
        enabled: false,
        anchor: "bottom-right",
        motion: "auto",
        mutedBubbles: false,
        size: 96,
      },
    }
    const { container } = render(<PetMount />)
    expect(container.firstChild).toBeNull()
    expect(usePetEventBus).toHaveBeenCalledWith(false)
  })

  it("renders the widget and initializes when enabled", () => {
    settingsValue = {
      petSettings: {
        enabled: true,
        anchor: "bottom-right",
        motion: "auto",
        mutedBubbles: false,
        size: 96,
      },
    }
    const { getByTestId } = render(<PetMount />)
    expect(getByTestId("pet-widget")).toBeInTheDocument()
    expect(usePetEventBus).toHaveBeenCalledWith(true)
  })

  it("defaults settings when petSettings is absent", () => {
    settingsValue = {}
    render(<PetMount />)
    expect(usePetEventBus).toHaveBeenCalledWith(true) // DEFAULT_PET_SETTINGS.enabled
  })
})
