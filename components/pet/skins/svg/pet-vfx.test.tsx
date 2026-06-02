import { render } from "@testing-library/react"
import { PetVfx } from "./pet-vfx"

function renderVfx(props: Parameters<typeof PetVfx>[0]) {
  return render(
    <svg>
      <PetVfx {...props} />
    </svg>
  )
}

describe("PetVfx", () => {
  it("renders nothing under reduced motion", () => {
    const { container } = renderVfx({
      state: "error",
      oneShot: "petted",
      shiny: true,
      reducedMotion: true,
    })
    expect(container.querySelector('[data-pet-part="vfx"]')).toBeNull()
  })

  it("renders hearts on the petted one-shot", () => {
    const { container } = renderVfx({
      state: "interacting",
      oneShot: "petted",
      shiny: false,
      reducedMotion: false,
    })
    expect(container.querySelectorAll('[data-pet-vfx="heart"]').length).toBeGreaterThan(0)
  })

  it("renders sparkles on level-up and evolving", () => {
    for (const oneShot of ["levelUp", "evolving"] as const) {
      const { container, unmount } = renderVfx({
        state: "idle",
        oneShot,
        shiny: false,
        reducedMotion: false,
      })
      expect(container.querySelectorAll('[data-pet-vfx="sparkle"]').length).toBeGreaterThan(0)
      unmount()
    }
  })

  it("renders a shiny shimmer when shiny", () => {
    const { container } = renderVfx({
      state: "idle",
      oneShot: null,
      shiny: true,
      reducedMotion: false,
    })
    expect(container.querySelector('[data-pet-vfx="shiny"]')).not.toBeNull()
  })

  it("renders a sweat drop in the error state", () => {
    const { container } = renderVfx({
      state: "error",
      oneShot: null,
      shiny: false,
      reducedMotion: false,
    })
    expect(container.querySelector('[data-pet-vfx="sweat"]')).not.toBeNull()
  })
})
