import { render, screen } from "@testing-library/react"

import { PetVitalsCard } from "./pet-vitals-card"
import { levelProgress } from "@/lib/pet/xp/leveling"

describe("PetVitalsCard", () => {
  it("renders the level line with the derived level and XP split", () => {
    const progress = levelProgress(150)
    render(<PetVitalsCard xp={150} needs={{ energy: 80, mood: 60, bond: 40 }} />)
    expect(screen.getByTestId("pet-vitals-card")).toHaveTextContent(`Level ${progress.level}`)
    expect(screen.getByTestId("pet-vitals-card")).toHaveTextContent(
      `${progress.intoLevel}/${progress.span}`
    )
  })

  it("shows mood and unwell chips when given, and hides them otherwise", () => {
    const { rerender } = render(
      <PetVitalsCard
        xp={0}
        needs={{ energy: 10, mood: 10, bond: 10 }}
        mood="grumpy"
        condition="unwell"
      />
    )
    expect(screen.getByTestId("pet-mood-chip")).toHaveAttribute("data-mood", "grumpy")
    expect(screen.getByTestId("pet-condition-chip")).toBeInTheDocument()

    rerender(
      <PetVitalsCard
        xp={0}
        needs={{ energy: 90, mood: 90, bond: 90 }}
        mood="happy"
        condition="well"
      />
    )
    expect(screen.getByTestId("pet-mood-chip")).toHaveAttribute("data-mood", "happy")
    expect(screen.queryByTestId("pet-condition-chip")).toBeNull()

    rerender(<PetVitalsCard xp={0} needs={{ energy: 90, mood: 90, bond: 90 }} />)
    expect(screen.queryByTestId("pet-mood-chip")).toBeNull()
  })

  it("renders the three need bars with their values", () => {
    render(<PetVitalsCard xp={0} needs={{ energy: 80, mood: 60, bond: 40 }} />)
    for (const [kind, value] of [
      ["energy", 80],
      ["mood", 60],
      ["bond", 40],
    ] as const) {
      const bar = document.querySelector(`[data-need="${kind}"]`)
      expect(bar).not.toBeNull()
      expect(bar).toHaveTextContent(String(value))
    }
  })

  it("supports a flat page variant", () => {
    render(<PetVitalsCard xp={0} needs={{ energy: 80, mood: 60, bond: 40 }} variant="flat" />)
    expect(screen.getByTestId("pet-vitals-card")).toHaveAttribute("data-variant", "flat")
    expect(screen.getByTestId("pet-vitals-card")).not.toHaveClass("border")
  })
})
