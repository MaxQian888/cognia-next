import { render } from "@testing-library/react"
import { PetRenderer } from "./pet-renderer"
import type { PetBones } from "@/types/pet"

function makeBones(overrides: Partial<PetBones> = {}): PetBones {
  return {
    species: "duck",
    rarity: "epic",
    stars: 4,
    eyes: "star",
    hat: "beanie",
    shiny: false,
    bodyType: "wide",
    palette: { primary: "#aabbcc", secondary: "#ddeeff", accent: "#112233" },
    stats: { debugging: 1, patience: 1, chaos: 1, wisdom: 1, snark: 1 },
    ...overrides,
  }
}

describe("PetRenderer", () => {
  it("renders the svg skin by default", () => {
    const { container } = render(<PetRenderer bones={makeBones()} stage="baby" state="idle" />)
    expect(container.querySelector('[data-pet-skin-root="svg"]')).not.toBeNull()
  })

  it("passes an explicit reducedMotion flag through (suppresses vfx)", () => {
    const { container } = render(
      <PetRenderer bones={makeBones({ shiny: true })} stage="adult" state="idle" reducedMotion />
    )
    expect(container.querySelector('[data-pet-part="vfx"]')).toBeNull()
  })

  it("falls back to the svg skin for an unknown skin id", () => {
    const { container } = render(
      <PetRenderer bones={makeBones()} stage="adult" state="idle" skinId="nope" />
    )
    expect(container.querySelector('[data-pet-skin-root="svg"]')).not.toBeNull()
  })
})
