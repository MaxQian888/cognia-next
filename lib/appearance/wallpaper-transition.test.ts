import {
  imageVarFor,
  inactivePhase,
  planTransition,
  slideOffset,
  TRANSITION_VARS,
  type TransitionPlanInput,
} from "./wallpaper-transition"
import {
  DEFAULT_WALLPAPER_ROTATION,
  MAX_TRANSITION_MS,
  transitionNeedsTwoLayers,
  WALLPAPER_TRANSITIONS,
  type WallpaperTransition,
} from "@/types/appearance/wallpaper-rotation"

function input(patch: Partial<TransitionPlanInput> = {}): TransitionPlanInput {
  return {
    rotation: { ...DEFAULT_WALLPAPER_ROTATION },
    scrimActive: false,
    reducedMotion: false,
    ...patch,
  }
}

describe("planTransition", () => {
  it("passes the requested transition through untouched", () => {
    const plan = planTransition(input())
    expect(plan.effective).toBe("crossfade")
    expect(plan.twoLayer).toBe(true)
    expect(plan.degradedBy).toBeNull()
  })

  it("collapses to an instant swap under reduced motion", () => {
    const plan = planTransition(input({ reducedMotion: true }))
    expect(plan.effective).toBe("none")
    expect(plan.durationMs).toBe(0)
    expect(plan.twoLayer).toBe(false)
    expect(plan.degradedBy).toBe("reduced-motion")
  })

  it("honours an explicit opt-out of the reduced-motion collapse", () => {
    const plan = planTransition(
      input({
        reducedMotion: true,
        rotation: { ...DEFAULT_WALLPAPER_ROTATION, respectReducedMotion: false },
      })
    )
    expect(plan.effective).toBe("crossfade")
    expect(plan.degradedBy).toBeNull()
  })

  it("degrades a two-layer transition to fade while the scrim holds ::after", () => {
    const plan = planTransition(input({ scrimActive: true }))
    expect(plan.effective).toBe("fade")
    expect(plan.twoLayer).toBe(false)
    expect(plan.degradedBy).toBe("scrim")
  })

  it("leaves a one-layer transition alone under the scrim", () => {
    const plan = planTransition(
      input({
        scrimActive: true,
        rotation: { ...DEFAULT_WALLPAPER_ROTATION, transition: "fade" },
      })
    )
    expect(plan.effective).toBe("fade")
    expect(plan.degradedBy).toBeNull()
  })

  it("lets reduced motion win over the scrim when both apply", () => {
    const plan = planTransition(input({ scrimActive: true, reducedMotion: true }))
    expect(plan.effective).toBe("none")
    expect(plan.degradedBy).toBe("reduced-motion")
  })

  it("clamps an out-of-range duration", () => {
    const plan = planTransition(
      input({ rotation: { ...DEFAULT_WALLPAPER_ROTATION, transitionMs: 99_999 } })
    )
    expect(plan.durationMs).toBe(MAX_TRANSITION_MS)
  })

  it("resolves the easing keyword to a CSS timing function", () => {
    const plan = planTransition(
      input({ rotation: { ...DEFAULT_WALLPAPER_ROTATION, easing: "easeOut" } })
    )
    expect(plan.easingCss).toBe("cubic-bezier(0, 0, 0.2, 1)")
  })

  it("never degrades fade further, since it is the degradation target", () => {
    // The contract that makes the scrim fallback terminate. If `fade` ever
    // starts needing two layers this test is the thing that catches it.
    expect(transitionNeedsTwoLayers("fade")).toBe(false)
    for (const transition of WALLPAPER_TRANSITIONS) {
      const plan = planTransition(
        input({ scrimActive: true, rotation: { ...DEFAULT_WALLPAPER_ROTATION, transition } })
      )
      expect(plan.twoLayer).toBe(false)
      expect(transitionNeedsTwoLayers(plan.effective)).toBe(false)
    }
  })

  it("reports twoLayer consistently with the type-level predicate", () => {
    for (const transition of WALLPAPER_TRANSITIONS) {
      const plan = planTransition(
        input({ rotation: { ...DEFAULT_WALLPAPER_ROTATION, transition } })
      )
      expect(plan.twoLayer).toBe(transitionNeedsTwoLayers(transition as WallpaperTransition))
    }
  })
})

describe("phase helpers", () => {
  it("alternates phases", () => {
    expect(inactivePhase("a")).toBe("b")
    expect(inactivePhase("b")).toBe("a")
  })

  it("keeps layer A on the historical variable name", () => {
    // The wallpaper settings panel writes this var directly during a slider
    // drag. Renaming it would silently break the live preview.
    expect(imageVarFor("a")).toBe("--app-bg-image")
    expect(TRANSITION_VARS.imageA).toBe("--app-bg-image")
  })

  it("maps layer B to its own variable", () => {
    expect(imageVarFor("b")).toBe("--app-bg-image-b")
  })
})

describe("slideOffset", () => {
  it("sends the incoming layer travelling in the named direction", () => {
    // "left" means the image moves leftwards, so it must START to the right.
    expect(slideOffset("left")).toEqual({ x: "8vw", y: "0" })
    expect(slideOffset("right")).toEqual({ x: "-8vw", y: "0" })
    expect(slideOffset("up")).toEqual({ x: "0", y: "8vh" })
    expect(slideOffset("down")).toEqual({ x: "0", y: "-8vh" })
  })
})
