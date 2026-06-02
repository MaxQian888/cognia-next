import { render, screen, fireEvent } from "@testing-library/react"

const save = jest.fn()
let settingsValue: unknown = {}
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: settingsValue, save }),
}))
const resetPet = jest.fn()
jest.mock("@/lib/db/pet", () => ({ resetPet: () => resetPet() }))

import { PetSection } from "./pet-section"

beforeEach(() => {
  save.mockClear()
  resetPet.mockClear()
  settingsValue = {
    petSettings: {
      enabled: true,
      anchor: "bottom-right",
      motion: "auto",
      mutedBubbles: false,
      size: 96,
    },
  }
})

describe("PetSection", () => {
  it("toggles the enabled switch through save()", () => {
    render(<PetSection />)
    fireEvent.click(screen.getByRole("switch", { name: /enable|enabled\.label/i }))
    expect(save).toHaveBeenCalledWith({ petSettings: expect.objectContaining({ enabled: false }) })
  })

  it("changes the anchor", () => {
    render(<PetSection />)
    const anchor = document.getElementById("pet-anchor") as HTMLSelectElement
    fireEvent.change(anchor, { target: { value: "top-left" } })
    expect(save).toHaveBeenCalledWith({
      petSettings: expect.objectContaining({ anchor: "top-left" }),
    })
  })

  it("resets the pet", () => {
    render(<PetSection />)
    fireEvent.click(screen.getByRole("button", { name: /reset|reset\.action/i }))
    expect(resetPet).toHaveBeenCalled()
  })

  it("falls back to defaults when petSettings is absent", () => {
    settingsValue = {}
    render(<PetSection />)
    // default enabled=true → toggling sends enabled:false
    fireEvent.click(screen.getByRole("switch", { name: /enable|enabled\.label/i }))
    expect(save).toHaveBeenCalledWith({ petSettings: expect.objectContaining({ enabled: false }) })
  })
})
