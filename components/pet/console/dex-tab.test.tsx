import { render, screen } from "@testing-library/react"
import { DexTab } from "./dex-tab"
import { ALL_PET_SPECIES } from "@/lib/pet/skins/species-traits"
import type { PetBones } from "@/types/pet"

const bones: PetBones = {
  species: "cat",
  rarity: "rare",
  stars: 3,
  eyes: "dot",
  hat: "beanie",
  shiny: false,
  bodyType: "round",
  palette: { primary: "#a", secondary: "#b", accent: "#c" },
  stats: { debugging: 1, patience: 1, chaos: 1, wisdom: 1, snark: 1 },
}

describe("DexTab", () => {
  it("renders every species and marks the owned one", () => {
    render(<DexTab bones={bones} />)
    expect(screen.getByTestId("pet-dex").querySelectorAll("[data-owned]")).toHaveLength(
      ALL_PET_SPECIES.length
    )
    expect(document.querySelector('[data-owned][data-species="cat"]')).toHaveAttribute(
      "data-owned",
      "true"
    )
    expect(document.querySelector('[data-owned][data-species="owl"]')).toHaveAttribute(
      "data-owned",
      "false"
    )
  })
})
