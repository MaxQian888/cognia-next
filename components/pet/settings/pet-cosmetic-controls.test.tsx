import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("../pet-renderer", () => ({ PetRenderer: () => <div data-testid="pet-preview" /> }))
const patchPetProfile = jest.fn()
jest.mock("@/lib/db/pet", () => ({ patchPetProfile: (p: unknown) => patchPetProfile(p) }))
const mockUsePet = jest.fn()
jest.mock("@/hooks/pet/use-pet", () => ({ usePet: () => mockUsePet() }))

import { PetCosmeticControls } from "./pet-cosmetic-controls"
import { PALETTE_PRESETS } from "@/lib/pet/bones/palettes"
import { createDefaultProfile } from "@/lib/pet/defaults"
import { computePetView } from "@/lib/pet/runtime/pet-view"
import type { PetProfile } from "@/types/pet"

function petResult(over: Partial<PetProfile> = {}) {
  const profile: PetProfile = {
    ...createDefaultProfile("acct-1", 0),
    soul: { name: "Boba", personality: "x", hatchDate: "" },
    stage: "baby",
    ...over,
  }
  return { profile, view: computePetView(profile, null, 0), loading: false }
}

beforeEach(() => {
  patchPetProfile.mockClear()
  mockUsePet.mockReset()
})

describe("PetCosmeticControls", () => {
  it("prompts to hatch first when there is no soul", () => {
    mockUsePet.mockReturnValue(petResult({ soul: null, stage: "egg" }))
    render(<PetCosmeticControls />)
    expect(screen.getByText(/hatch your pet first/i)).toBeInTheDocument()
  })

  it("applies a palette preset and overrides hat/eyes/body", () => {
    mockUsePet.mockReturnValue(petResult())
    render(<PetCosmeticControls />)
    fireEvent.click(screen.getByLabelText(PALETTE_PRESETS[0].id, { exact: false }))
    expect(patchPetProfile).toHaveBeenCalledWith({
      cosmetic: { palette: PALETTE_PRESETS[0].palette },
    })
    fireEvent.change(document.getElementById("pet-cosmetic-hat") as HTMLSelectElement, {
      target: { value: "crown" },
    })
    expect(patchPetProfile).toHaveBeenCalledWith({ cosmetic: { hat: "crown" } })
  })

  it("overrides eyes/body and clears the palette back to default", () => {
    mockUsePet.mockReturnValue(petResult({ cosmetic: { palette: PALETTE_PRESETS[1].palette } }))
    render(<PetCosmeticControls />)
    fireEvent.change(document.getElementById("pet-cosmetic-eyes") as HTMLSelectElement, {
      target: { value: "star" },
    })
    expect(patchPetProfile).toHaveBeenCalledWith({
      cosmetic: expect.objectContaining({ eyes: "star" }),
    })
    fireEvent.change(document.getElementById("pet-cosmetic-body") as HTMLSelectElement, {
      target: { value: "tall" },
    })
    expect(patchPetProfile).toHaveBeenCalledWith({
      cosmetic: expect.objectContaining({ bodyType: "tall" }),
    })
    // The ✕ swatch clears the palette override → cosmetic becomes empty → undefined.
    fireEvent.click(screen.getByLabelText(/default|cosmetic\.default/i, { selector: "button" }))
    expect(patchPetProfile).toHaveBeenCalledWith({ cosmetic: undefined })
  })

  it("disables reset when there is no override yet", () => {
    mockUsePet.mockReturnValue(petResult())
    render(<PetCosmeticControls />)
    expect(screen.getByRole("button", { name: /reset to genetics/i })).toBeDisabled()
  })

  it("clearing a field's override drops it; reset wipes the whole cosmetic", () => {
    mockUsePet.mockReturnValue(petResult({ cosmetic: { hat: "crown", eyes: "star" } }))
    render(<PetCosmeticControls />)
    // Setting hat back to default removes only the hat key.
    fireEvent.change(document.getElementById("pet-cosmetic-hat") as HTMLSelectElement, {
      target: { value: "" },
    })
    expect(patchPetProfile).toHaveBeenCalledWith({ cosmetic: { eyes: "star" } })
    // Reset clears everything.
    fireEvent.click(screen.getByRole("button", { name: /reset to genetics/i }))
    expect(patchPetProfile).toHaveBeenCalledWith({ cosmetic: undefined })
  })
})
