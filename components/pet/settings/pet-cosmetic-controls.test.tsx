import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("../pet-renderer", () => ({ PetRenderer: () => <div data-testid="pet-preview" /> }))
const patchPetProfile = jest.fn()
jest.mock("@/lib/db/pet", () => ({
  patchPetProfile: (p: unknown) => patchPetProfile(p),
  listPetInventory: () => Promise.resolve([]),
}))
const mockUsePet = jest.fn()
jest.mock("@/hooks/pet/use-pet", () => ({ usePet: () => mockUsePet() }))
// Controllable owned-inventory snapshot for the hat-gating reads.
let inventoryValue: unknown[]
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => inventoryValue }))

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
  // Own every purchasable hat by default so pre-gating interaction tests keep
  // exercising the select; the gating test overrides this with an empty list.
  inventoryValue = [
    { id: "star-charm", qty: 1 },
    { id: "tophat-box", qty: 1 },
    { id: "wizard-hat", qty: 1 },
    { id: "halo-ring", qty: 1 },
    { id: "propeller-cap", qty: 1 },
    { id: "beanie", qty: 1 },
  ]
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

  it("locks purchasable hats until their decor item is owned", () => {
    inventoryValue = []
    const result = petResult()
    mockUsePet.mockReturnValue(result)
    render(<PetCosmeticControls />)
    const select = document.getElementById("pet-cosmetic-hat") as HTMLSelectElement
    const option = (value: string) =>
      select.querySelector(`option[value="${value}"]`) as HTMLOptionElement
    const geneticHat = result.view.bones.hat
    // Every shop-backed hat is disabled with an empty inventory — except the
    // pet's own genetic hat, which is always free.
    for (const hat of ["crown", "tophat", "wizard", "halo", "propeller", "beanie"]) {
      expect(option(hat).disabled).toBe(hat !== geneticHat)
    }
    // Genetics-only legendary hat never unlocks via the shop.
    expect(option("tinyduck").disabled).toBe(geneticHat !== "tinyduck")
    // Bare-headed stays free.
    expect(option("none").disabled).toBe(false)
  })

  it("keeps an already-applied locked hat selectable so profiles can't get stuck", () => {
    inventoryValue = []
    const result = petResult({ cosmetic: { hat: "wizard" } })
    mockUsePet.mockReturnValue(result)
    render(<PetCosmeticControls />)
    const select = document.getElementById("pet-cosmetic-hat") as HTMLSelectElement
    const wizard = select.querySelector('option[value="wizard"]') as HTMLOptionElement
    expect(wizard.disabled).toBe(false)
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
