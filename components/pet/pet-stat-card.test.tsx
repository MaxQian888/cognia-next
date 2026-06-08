import { render, screen } from "@testing-library/react"
import { PetStatCard } from "./pet-stat-card"
import type { PetBones, PetSoul } from "@/types/pet"

function makeBones(overrides: Partial<PetBones> = {}): PetBones {
  return {
    species: "cat",
    rarity: "legendary",
    stars: 5,
    eyes: "star",
    hat: "crown",
    shiny: true,
    bodyType: "round",
    palette: { primary: "#a", secondary: "#b", accent: "#c" },
    stats: { debugging: 90, patience: 10, chaos: 50, wisdom: 70, snark: 30 },
    ...overrides,
  }
}

const soul: PetSoul = { name: "Boba", personality: "Smug.", hatchDate: new Date(0).toISOString() }

describe("PetStatCard", () => {
  it("shows the soul name, rarity, star count and shiny badge", () => {
    const { container } = render(<PetStatCard bones={makeBones()} soul={soul} stage="adult" />)
    expect(screen.getByText("Boba")).toBeInTheDocument()
    expect(container.querySelector('[data-rarity="legendary"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="pet-stars"]')?.children).toHaveLength(5)
    expect(container.querySelector('[data-testid="pet-shiny-badge"]')).not.toBeNull()
  })

  it("renders all five stat bars with the right widths", () => {
    const { container } = render(<PetStatCard bones={makeBones()} soul={soul} stage="adult" />)
    expect(container.querySelectorAll("[data-stat]")).toHaveLength(5)
    const debugging = container.querySelector('[data-stat="debugging"] .bg-primary') as HTMLElement
    expect(debugging.style.width).toBe("90%")
  })

  it("shows earned growth as an overfill segment and the effective value", () => {
    const { container } = render(
      <PetStatCard
        bones={makeBones({
          stats: { debugging: 90, patience: 10, chaos: 50, wisdom: 70, snark: 30 },
        })}
        soul={soul}
        stage="adult"
        progress={{ debugging: 5, patience: 0, chaos: 0, wisdom: 0, snark: 0 }}
      />
    )
    const growth = container.querySelector(
      '[data-testid="pet-stat-growth-debugging"]'
    ) as HTMLElement
    expect(growth).not.toBeNull()
    expect(growth.style.width).toBe("5%")
    // Effective value (95) shows in the readout.
    expect(container.querySelector('[data-stat="debugging"]')?.textContent).toContain("95")
  })

  it("marks stats that just grew", () => {
    const { container } = render(
      <PetStatCard bones={makeBones()} soul={soul} stage="adult" grew={["patience"]} />
    )
    expect(container.querySelector('[data-stat="patience"][data-grew="true"]')).not.toBeNull()
    expect(container.querySelector('[data-stat="chaos"][data-grew]')).toBeNull()
  })

  it("shows an unhatched label and no shiny badge when appropriate", () => {
    const { container } = render(
      <PetStatCard bones={makeBones({ shiny: false })} soul={null} stage="egg" />
    )
    expect(container.querySelector('[data-testid="pet-shiny-badge"]')).toBeNull()
    // unhatched label key resolves (mock returns key path when message missing)
    expect(screen.getByText(/unhatched|statCard\.unhatched/i)).toBeInTheDocument()
  })
})
