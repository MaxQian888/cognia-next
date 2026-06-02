import { render } from "@testing-library/react"
import { PetBody } from "./pet-body"
import { ALL_PET_SPECIES } from "@/lib/pet/skins/species-traits"
import type { PetBones, PetBodyType, PetHat } from "@/types/pet"

function makeBones(overrides: Partial<PetBones> = {}): PetBones {
  return {
    species: "cat",
    rarity: "common",
    stars: 1,
    eyes: "dot",
    hat: "none",
    shiny: false,
    bodyType: "round",
    palette: { primary: "#aabbcc", secondary: "#ddeeff", accent: "#112233" },
    stats: { debugging: 1, patience: 1, chaos: 1, wisdom: 1, snark: 1 },
    ...overrides,
  }
}

describe("PetBody", () => {
  it("renders a body with species + body-type markers for every species", () => {
    for (const species of ALL_PET_SPECIES) {
      const { container, unmount } = render(
        <svg>
          <PetBody bones={makeBones({ species })} />
        </svg>
      )
      expect(container.querySelector(`[data-species="${species}"]`)).not.toBeNull()
      unmount()
    }
  })

  it("renders every hat variant", () => {
    const hats: PetHat[] = [
      "none",
      "crown",
      "tophat",
      "propeller",
      "halo",
      "wizard",
      "beanie",
      "tinyduck",
    ]
    for (const hat of hats) {
      const { container, unmount } = render(
        <svg>
          <PetBody bones={makeBones({ hat })} />
        </svg>
      )
      if (hat === "none") {
        expect(container.querySelector('[data-pet-part="hat"]')).toBeNull()
      } else {
        expect(container.querySelector(`[data-hat="${hat}"]`)).not.toBeNull()
      }
      unmount()
    }
  })

  it("renders all three body types", () => {
    const types: PetBodyType[] = ["round", "tall", "wide"]
    for (const bodyType of types) {
      const { container, unmount } = render(
        <svg>
          <PetBody bones={makeBones({ bodyType })} />
        </svg>
      )
      expect(container.querySelector(`[data-body-type="${bodyType}"]`)).not.toBeNull()
      unmount()
    }
  })

  it("omits cheeks for a non-cheeky species (owl)", () => {
    const { container } = render(
      <svg>
        <PetBody bones={makeBones({ species: "owl" })} />
      </svg>
    )
    expect(container.querySelector('[data-pet-part="cheeks"]')).toBeNull()
  })
})
