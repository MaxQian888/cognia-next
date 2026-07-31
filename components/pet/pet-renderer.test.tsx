import { render } from "@testing-library/react"
import { PetRenderer } from "./pet-renderer"
import type { PetBones } from "@/types/pet"
import { registerSkin } from "./skins/registry"

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

  it("passes an explicit reducedMotion flag through (animation off, identity kept)", () => {
    const { container } = render(
      <PetRenderer bones={makeBones({ shiny: true })} stage="adult" state="idle" reducedMotion />
    )
    // Epic rarity keeps a fully static aura (identity); animated effects
    // (shiny shimmer) are suppressed.
    expect(container.querySelector('[data-vfx-static="true"]')).not.toBeNull()
    expect(container.querySelector('[data-pet-vfx="shiny"]')).toBeNull()
    // Common rarity renders no VFX at all under reduced motion.
    const common = render(
      <PetRenderer
        bones={makeBones({ rarity: "common" })}
        stage="adult"
        state="idle"
        reducedMotion
      />
    )
    expect(common.container.querySelector('[data-pet-part="vfx"]')).toBeNull()
  })

  it("falls back to the svg skin for an unknown skin id", () => {
    const { container } = render(
      <PetRenderer bones={makeBones()} stage="adult" state="idle" skinId="nope" />
    )
    expect(container.querySelector('[data-pet-skin-root="svg"]')).not.toBeNull()
  })

  it("does not rerender an unchanged skin during parent animation frames", () => {
    const renderSkin = jest.fn(() => <div data-testid="memo-skin" />)
    registerSkin({ id: "memo-test", render: renderSkin })
    const bones = makeBones()
    const { rerender } = render(
      <PetRenderer bones={bones} stage="adult" state="idle" skinId="memo-test" reducedMotion />
    )
    const initialRenderCount = renderSkin.mock.calls.length

    rerender(
      <PetRenderer bones={bones} stage="adult" state="idle" skinId="memo-test" reducedMotion />
    )
    expect(renderSkin).toHaveBeenCalledTimes(initialRenderCount)

    rerender(
      <PetRenderer bones={bones} stage="adult" state="thinking" skinId="memo-test" reducedMotion />
    )
    expect(renderSkin).toHaveBeenCalledTimes(initialRenderCount + 1)
  })
})
