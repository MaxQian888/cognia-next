import { render, fireEvent } from "@testing-library/react"
import { PetCareControls } from "./pet-care-controls"
import { DEFAULT_PET_SETTINGS } from "@/types/pet"

describe("PetCareControls", () => {
  it("toggles low-power and care alerts", () => {
    const patch = jest.fn()
    render(<PetCareControls pet={DEFAULT_PET_SETTINGS} patch={patch} />)
    fireEvent.click(document.getElementById("pet-low-power") as HTMLButtonElement)
    expect(patch).toHaveBeenCalledWith({ lowPower: true })
    fireEvent.click(document.getElementById("pet-care-alerts") as HTMLButtonElement)
    // careAlerts defaults to on (undefined !== false), so toggling sends false.
    expect(patch).toHaveBeenCalledWith({ careAlerts: false })
  })

  it("reflects explicit off states and toggles them back on", () => {
    const patch = jest.fn()
    render(
      <PetCareControls
        pet={{ ...DEFAULT_PET_SETTINGS, lowPower: true, careAlerts: false }}
        patch={patch}
      />
    )
    fireEvent.click(document.getElementById("pet-low-power") as HTMLButtonElement)
    expect(patch).toHaveBeenCalledWith({ lowPower: false })
    fireEvent.click(document.getElementById("pet-care-alerts") as HTMLButtonElement)
    expect(patch).toHaveBeenCalledWith({ careAlerts: true })
  })

  it("treats an absent lowPower as off (nullish fallback)", () => {
    render(
      <PetCareControls pet={{ ...DEFAULT_PET_SETTINGS, lowPower: undefined }} patch={jest.fn()} />
    )
    expect(document.getElementById("pet-low-power")).toHaveAttribute("aria-checked", "false")
  })
})
