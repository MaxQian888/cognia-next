import { render } from "@testing-library/react"
import { svgSkin } from "./svg-skin"
import type { PetBones, PetSkinRenderProps } from "@/types/pet"

function makeBones(overrides: Partial<PetBones> = {}): PetBones {
  return {
    species: "fox",
    rarity: "rare",
    stars: 3,
    eyes: "wide",
    hat: "crown",
    shiny: true,
    bodyType: "tall",
    palette: { primary: "#aabbcc", secondary: "#ddeeff", accent: "#112233" },
    stats: { debugging: 1, patience: 1, chaos: 1, wisdom: 1, snark: 1 },
    ...overrides,
  }
}

function props(overrides: Partial<PetSkinRenderProps> = {}): PetSkinRenderProps {
  return {
    bones: makeBones(),
    stage: "adult",
    state: "idle",
    oneShot: null,
    reducedMotion: false,
    size: 96,
    ...overrides,
  }
}

describe("svgSkin", () => {
  it("renders an svg root carrying the visual state", () => {
    const { container } = render(<>{svgSkin.render(props({ state: "thinking" }))}</>)
    const root = container.querySelector('[data-pet-skin-root="svg"]')
    expect(root).not.toBeNull()
    expect(container.querySelector('[data-pet-state="thinking"]')).not.toBeNull()
  })

  it("renders an egg (no body) for the egg stage", () => {
    const { container } = render(<>{svgSkin.render(props({ stage: "egg" }))}</>)
    expect(container.querySelector('[data-pet-part="egg"]')).not.toBeNull()
    expect(container.querySelector('[data-pet-part="body"]')).toBeNull()
  })

  it("renders the body (not an egg) for a hatched stage", () => {
    const { container } = render(<>{svgSkin.render(props({ stage: "adult" }))}</>)
    expect(container.querySelector('[data-pet-part="body"]')).not.toBeNull()
    expect(container.querySelector('[data-pet-part="egg"]')).toBeNull()
  })

  it("still renders statically under reduced motion", () => {
    const { container } = render(
      <>{svgSkin.render(props({ reducedMotion: true, state: "happy" }))}</>
    )
    expect(container.querySelector('[data-pet-skin-root="svg"]')).not.toBeNull()
    // VFX layer is suppressed under reduced motion
    expect(container.querySelector('[data-pet-part="vfx"]')).toBeNull()
  })

  it("reflects the active one-shot", () => {
    const { container } = render(<>{svgSkin.render(props({ oneShot: "wave" }))}</>)
    expect(container.querySelector('[data-pet-oneshot="wave"]')).not.toBeNull()
  })

  it("defaults to facing right with resting locomotion", () => {
    const { container } = render(<>{svgSkin.render(props())}</>)
    const root = container.querySelector('[data-pet-skin-root="svg"]') as SVGElement
    expect(root.getAttribute("data-pet-facing")).toBe("right")
    expect(root.getAttribute("data-pet-locomotion")).toBe("resting")
    expect(root.style.transform).toBe("")
  })

  it("mirrors the svg and tags the walk while walking left", () => {
    const { container } = render(
      <>{svgSkin.render(props({ locomotion: { mode: "walking", facing: "left" } }))}</>
    )
    const root = container.querySelector('[data-pet-skin-root="svg"]') as SVGElement
    expect(root.getAttribute("data-pet-facing")).toBe("left")
    expect(root.getAttribute("data-pet-locomotion")).toBe("walking")
    expect(root.style.transform).toBe("scaleX(-1)")
  })

  it("renders a still frame when paused (vfx suppressed like reduced motion)", () => {
    const { container } = render(<>{svgSkin.render(props({ paused: true, state: "happy" }))}</>)
    expect(container.querySelector('[data-pet-skin-root="svg"]')).not.toBeNull()
    expect(container.querySelector('[data-pet-part="vfx"]')).toBeNull()
  })

  it("one-shots take precedence over the walking overlay", () => {
    const { container } = render(
      <>
        {svgSkin.render(
          props({ oneShot: "wave", locomotion: { mode: "walking", facing: "right" } })
        )}
      </>
    )
    expect(container.querySelector('[data-pet-oneshot="wave"]')).not.toBeNull()
  })
})
