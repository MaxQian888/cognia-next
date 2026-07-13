import { render } from "@testing-library/react"
import { svgSkin } from "./svg-skin"
import { useSettingsStore } from "@/stores/settings"
import type { PetBones, PetSkinRenderProps } from "@/types/pet"
import type { AppSettings } from "@cognia/agent-config-types"

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
  it("halves the looping cadence under low power (settings-driven)", () => {
    const before = useSettingsStore.getState().settings
    const baseline = render(<>{svgSkin.render(props())}</>)
    const normalSec = Number(
      baseline.container.querySelector('[data-pet-skin="svg"]')?.getAttribute("data-pet-loop-sec")
    )
    baseline.unmount()
    try {
      useSettingsStore.setState({
        settings: { petSettings: { lowPower: true } } as unknown as AppSettings,
      })
      const { container } = render(<>{svgSkin.render(props())}</>)
      const slowSec = Number(
        container.querySelector('[data-pet-skin="svg"]')?.getAttribute("data-pet-loop-sec")
      )
      expect(slowSec).toBe(normalSec * 2)
    } finally {
      useSettingsStore.setState({ settings: before })
    }
  })

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

  it("still renders statically under reduced motion (identity kept, motion dropped)", () => {
    const { container } = render(
      <>{svgSkin.render(props({ reducedMotion: true, state: "happy" }))}</>
    )
    expect(container.querySelector('[data-pet-skin-root="svg"]')).not.toBeNull()
    // The VFX layer keeps rarity identity as a fully static aura, but every
    // animated effect (shiny shimmer, one-shot particles) is suppressed.
    expect(container.querySelector('[data-vfx-static="true"]')).not.toBeNull()
    expect(container.querySelector('[data-pet-vfx="shiny"]')).toBeNull()
    // Blink is suppressed on still frames.
    expect(container.querySelector('[data-pet-blink="off"]')).not.toBeNull()
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
  })

  it("tags the walk and animates the facing group while walking left", () => {
    const { container } = render(
      <>{svgSkin.render(props({ locomotion: { mode: "walking", facing: "left" } }))}</>
    )
    const root = container.querySelector('[data-pet-skin-root="svg"]') as SVGElement
    expect(root.getAttribute("data-pet-facing")).toBe("left")
    expect(root.getAttribute("data-pet-locomotion")).toBe("walking")
    // The mirror is a ~150ms motion tween on a dedicated group (a cartoon
    // turn), not an instant style flip on the root.
    expect(container.querySelector("[data-pet-facing-group]")).not.toBeNull()
    expect(root.style.transform).toBe("")
  })

  it("renders a still frame when paused (motion suppressed like reduced motion)", () => {
    const { container } = render(<>{svgSkin.render(props({ paused: true, state: "happy" }))}</>)
    expect(container.querySelector('[data-pet-skin-root="svg"]')).not.toBeNull()
    // Identity-only static VFX; no animated shimmer.
    expect(container.querySelector('[data-vfx-static="true"]')).not.toBeNull()
    expect(container.querySelector('[data-pet-vfx="shiny"]')).toBeNull()
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

  describe("evolution flavor", () => {
    it("radiant renders the warm flavor aura at full saturation", () => {
      const { container } = render(<>{svgSkin.render(props({ flavor: "radiant" }))}</>)
      expect(container.querySelector('[data-pet-vfx="flavor-aura"]')).not.toBeNull()
      const body = container.querySelector('[data-pet-flavor="radiant"]') as HTMLElement
      expect(body).not.toBeNull()
      expect(body.style.filter).toBe("")
    })

    it("plain desaturates the body without an aura", () => {
      const { container } = render(<>{svgSkin.render(props({ flavor: "plain" }))}</>)
      expect(container.querySelector('[data-pet-vfx="flavor-aura"]')).toBeNull()
      const body = container.querySelector('[data-pet-flavor="plain"]') as HTMLElement
      expect(body.style.filter).toContain("saturate(0.88)")
    })

    it("normal / absent flavor renders no flavor layer (determinism guard)", () => {
      const plainProps = props()
      const { container } = render(<>{svgSkin.render(plainProps)}</>)
      expect(container.querySelector('[data-pet-vfx="flavor-aura"]')).toBeNull()
      expect(container.querySelector('[data-pet-flavor="normal"]')).not.toBeNull()
      const withNormal = render(<>{svgSkin.render(props({ flavor: "normal" }))}</>)
      expect(withNormal.container.querySelector('[data-pet-vfx="flavor-aura"]')).toBeNull()
    })

    it("keeps the plain saturation but drops the radiant aura under reduced motion", () => {
      const { container } = render(
        <>{svgSkin.render(props({ flavor: "radiant", reducedMotion: true }))}</>
      )
      // Reduced motion removes the whole VFX layer (incl. the flavor aura).
      expect(container.querySelector('[data-pet-vfx="flavor-aura"]')).toBeNull()
      const plain = render(<>{svgSkin.render(props({ flavor: "plain", reducedMotion: true }))}</>)
      const body = plain.container.querySelector('[data-pet-flavor="plain"]') as HTMLElement
      expect(body.style.filter).toContain("saturate(0.88)")
    })
  })
})
