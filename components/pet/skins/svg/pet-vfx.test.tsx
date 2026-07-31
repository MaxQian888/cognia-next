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
  it("keeps rarity identity (static, unanimated) under reduced motion", () => {
    const { container } = renderVfx({
      state: "error",
      oneShot: "petted",
      shiny: true,
      rarity: "legendary",
      reducedMotion: true,
    })
    // A static aura + motes render; every animated effect stays off.
    expect(container.querySelector('[data-vfx-static="true"]')).not.toBeNull()
    expect(container.querySelector('[data-pet-vfx="aura"][data-static="true"]')).not.toBeNull()
    expect(container.querySelectorAll('[data-pet-vfx="mote"]').length).toBe(5)
    expect(container.querySelector('[data-pet-vfx="heart"]')).toBeNull()
    expect(container.querySelector('[data-pet-vfx="shiny"]')).toBeNull()
    expect(container.querySelector('[data-pet-vfx="sweat"]')).toBeNull()
  })

  it("renders nothing under reduced motion for a common pet", () => {
    const { container } = renderVfx({ rarity: "common", reducedMotion: true })
    expect(container.querySelector('[data-pet-part="vfx"]')).toBeNull()
  })

  it("renders hearts on the petted and love one-shots", () => {
    const petted = renderVfx({ state: "interacting", oneShot: "petted" })
    expect(petted.container.querySelectorAll('[data-pet-vfx="heart"]').length).toBe(2)
    petted.unmount()
    const love = renderVfx({ state: "interacting", oneShot: "love" })
    expect(love.container.querySelectorAll('[data-pet-vfx="heart"]').length).toBe(3)
  })

  it("renders a gold ring burst on level-up and sparkles on evolving", () => {
    const levelUp = renderVfx({ oneShot: "levelUp" })
    expect(levelUp.container.querySelectorAll('[data-pet-vfx="levelup-ring"]').length).toBe(2)
    expect(levelUp.container.querySelector('[data-pet-vfx="sparkle"]')).toBeNull()
    levelUp.unmount()
    const evolving = renderVfx({ oneShot: "evolving" })
    expect(evolving.container.querySelectorAll('[data-pet-vfx="sparkle"]').length).toBe(5)
    expect(evolving.container.querySelector('[data-pet-vfx="levelup-ring"]')).toBeNull()
  })

  it("renders crumbs while eating and an exclamation when surprised", () => {
    const fed = renderVfx({ oneShot: "fed" })
    expect(fed.container.querySelectorAll('[data-pet-vfx="crumb"]').length).toBe(3)
    fed.unmount()
    const surprised = renderVfx({ oneShot: "surprised" })
    expect(surprised.container.querySelector('[data-pet-vfx="exclaim"]')).not.toBeNull()
  })

  it("renders drifting Zzz while sleeping (state or one-shot)", () => {
    const sleeping = renderVfx({ state: "sleeping" })
    expect(sleeping.container.querySelectorAll('[data-pet-vfx="zzz"]').length).toBe(2)
    sleeping.unmount()
    const sleepy = renderVfx({ oneShot: "sleepy" })
    expect(sleepy.container.querySelectorAll('[data-pet-vfx="zzz"]').length).toBe(2)
  })

  it("renders dust puffs on the land one-shot", () => {
    const { container } = renderVfx({ oneShot: "land" })
    expect(container.querySelectorAll('[data-pet-vfx="dust"]').length).toBe(4)
  })

  it("renders hatch sparkles on the hatch one-shot", () => {
    const { container } = renderVfx({ oneShot: "hatch" })
    expect(container.querySelectorAll('[data-pet-vfx="sparkle"]').length).toBe(3)
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
