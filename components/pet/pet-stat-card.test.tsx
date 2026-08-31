import { render, screen } from "@testing-library/react"
import type { PetBones, PetSoul } from "@/types/pet"

// Stub the renderer so the preview avatar's skin choice is observable without
// pulling the live2d skin's stores/canvas into a stat-card unit test.
jest.mock("./pet-renderer", () => ({
  PetRenderer: ({ skinId, flavor }: { skinId?: string; flavor?: string }) => (
    <div data-testid="pet-preview" data-skin={skinId ?? "default"} data-flavor={flavor} />
  ),
}))

import { PetStatCard } from "./pet-stat-card"

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

  it("defaults the preview to the SVG skin and forwards an explicit skinId", () => {
    const { rerender } = render(<PetStatCard bones={makeBones()} soul={soul} stage="adult" />)
    expect(screen.getByTestId("pet-preview").dataset.skin).toBe("default")
    rerender(<PetStatCard bones={makeBones()} soul={soul} stage="adult" skinId="live2d" />)
    expect(screen.getByTestId("pet-preview").dataset.skin).toBe("live2d")
  })

  it("shows an unhatched label and no shiny badge when appropriate", () => {
    const { container } = render(
      <PetStatCard bones={makeBones({ shiny: false })} soul={null} stage="egg" />
    )
    expect(container.querySelector('[data-testid="pet-shiny-badge"]')).toBeNull()
    // unhatched label key resolves (mock returns key path when message missing)
    expect(screen.getByText(/unhatched|statCard\.unhatched/i)).toBeInTheDocument()
  })

  it("shows the evolution-flavor badge for radiant/plain and hides it for normal", () => {
    const { container, rerender } = render(
      <PetStatCard bones={makeBones()} soul={soul} stage="adult" flavor="radiant" />
    )
    const badge = container.querySelector('[data-testid="pet-flavor-badge"]')
    expect(badge).not.toBeNull()
    expect(badge).toHaveAttribute("data-flavor", "radiant")
    expect(screen.getByTestId("pet-preview")).toHaveAttribute("data-flavor", "radiant")

    rerender(<PetStatCard bones={makeBones()} soul={soul} stage="adult" flavor="plain" />)
    expect(container.querySelector('[data-flavor="plain"]')).not.toBeNull()

    rerender(<PetStatCard bones={makeBones()} soul={soul} stage="adult" flavor="normal" />)
    expect(container.querySelector('[data-testid="pet-flavor-badge"]')).toBeNull()

    rerender(<PetStatCard bones={makeBones()} soul={soul} stage="adult" />)
    expect(container.querySelector('[data-testid="pet-flavor-badge"]')).toBeNull()
  })

  it("supports a flat page variant without changing the default outlined variant", () => {
    const { rerender } = render(
      <PetStatCard bones={makeBones()} soul={soul} stage="adult" variant="flat" />
    )
    expect(screen.getByTestId("pet-stat-card")).toHaveAttribute("data-variant", "flat")
    expect(screen.getByTestId("pet-stat-card")).not.toHaveClass("border")

    rerender(<PetStatCard bones={makeBones()} soul={soul} stage="adult" />)
    expect(screen.getByTestId("pet-stat-card")).toHaveAttribute("data-variant", "outlined")
    expect(screen.getByTestId("pet-stat-card")).toHaveClass("border")
  })
})
