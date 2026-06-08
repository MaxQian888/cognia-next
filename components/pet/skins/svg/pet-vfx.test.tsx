import { render } from "@testing-library/react"
import { PetVfx } from "./pet-vfx"

function renderVfx(props: Partial<Parameters<typeof PetVfx>[0]>) {
  const full: Parameters<typeof PetVfx>[0] = {
    state: "idle",
    oneShot: null,
    shiny: false,
    rarity: "common",
    reducedMotion: false,
    ...props,
  }
  return render(
    <svg>
      <PetVfx {...full} />
    </svg>
  )
}

describe("PetVfx", () => {
  it("renders nothing under reduced motion", () => {
    const { container } = renderVfx({
      state: "error",
      oneShot: "petted",
      shiny: true,
      rarity: "legendary",
      reducedMotion: true,
    })
    expect(container.querySelector('[data-pet-part="vfx"]')).toBeNull()
  })

  it("renders hearts on the petted one-shot", () => {
    const { container } = renderVfx({ state: "interacting", oneShot: "petted" })
    expect(container.querySelectorAll('[data-pet-vfx="heart"]').length).toBeGreaterThan(0)
  })

  it("renders sparkles on level-up and evolving", () => {
    for (const oneShot of ["levelUp", "evolving"] as const) {
      const { container, unmount } = renderVfx({ oneShot })
      expect(container.querySelectorAll('[data-pet-vfx="sparkle"]').length).toBeGreaterThan(0)
      unmount()
    }
  })

  it("renders a shiny shimmer when shiny", () => {
    const { container } = renderVfx({ shiny: true })
    expect(container.querySelector('[data-pet-vfx="shiny"]')).not.toBeNull()
  })

  it("renders a sweat drop in the error state", () => {
    const { container } = renderVfx({ state: "error" })
    expect(container.querySelector('[data-pet-vfx="sweat"]')).not.toBeNull()
  })

  it("renders no aura for common rarity", () => {
    const { container } = renderVfx({ rarity: "common" })
    expect(container.querySelector('[data-pet-vfx="aura"]')).toBeNull()
  })

  it("renders an aura and orbiting motes for legendary", () => {
    const { container } = renderVfx({ rarity: "legendary" })
    expect(container.querySelector('[data-pet-vfx="aura"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-pet-vfx="mote"]').length).toBe(5)
  })

  it("halves the motes under low power", () => {
    const { container } = renderVfx({ rarity: "legendary", lowPower: true })
    expect(container.querySelectorAll('[data-pet-vfx="mote"]').length).toBe(2)
  })
})
