/** @jest-environment jsdom */

import {
  ATTR_ARMING,
  ATTR_TWO_LAYER,
  crossfadeToLayer,
  currentPhase,
  DISSOLVE_BLUR_PX,
  entryTransform,
  exitTransform,
  fadeToImage,
  normalizeToSingleLayer,
  rampDissolveBlur,
  transformVarFor,
  writeTransitionTiming,
} from "./background-layers"
import { planTransition, TRANSITION_ATTRS, TRANSITION_VARS } from "./wallpaper-transition"
import { BG_VARS } from "./background-fit"
import {
  DEFAULT_WALLPAPER_ROTATION,
  type WallpaperTransition,
} from "@/types/appearance/wallpaper-rotation"

function plan(transition: WallpaperTransition, patch: Record<string, unknown> = {}) {
  return planTransition({
    rotation: { ...DEFAULT_WALLPAPER_ROTATION, transition, ...patch },
    scrimActive: false,
    reducedMotion: false,
  })
}

function body(): HTMLElement {
  document.body.removeAttribute(TRANSITION_ATTRS.phase)
  document.body.removeAttribute(TRANSITION_ATTRS.transition)
  document.body.removeAttribute(ATTR_TWO_LAYER)
  document.body.removeAttribute(ATTR_ARMING)
  document.body.style.cssText = ""
  return document.body
}

describe("currentPhase", () => {
  it("defaults to layer A", () => {
    expect(currentPhase(body())).toBe("a")
  })

  it("reads an explicit phase", () => {
    const el = body()
    el.setAttribute(TRANSITION_ATTRS.phase, "b")
    expect(currentPhase(el)).toBe("b")
  })

  it("treats an unrecognised value as layer A rather than trusting it", () => {
    const el = body()
    el.setAttribute(TRANSITION_ATTRS.phase, "nonsense")
    expect(currentPhase(el)).toBe("a")
  })
})

describe("entryTransform / exitTransform", () => {
  it("is a no-op for pure opacity transitions", () => {
    for (const t of ["crossfade", "dissolve", "kenBurns", "fade", "none"] as const) {
      expect(entryTransform(plan(t))).toBe("none")
      expect(exitTransform(plan(t))).toBe("none")
    }
  })

  it("sends both slide layers the same way instead of crossing them", () => {
    const p = plan("slide", { slideDirection: "left" })
    expect(entryTransform(p)).toBe("translate3d(8vw, 0, 0)")
    // Negated, so the leaving layer keeps travelling leftwards too.
    expect(exitTransform(p)).toBe("translate3d(calc(-1 * 8vw), calc(-1 * 0), 0)")
  })

  it("zooms the incoming layer in and the outgoing layer away", () => {
    expect(entryTransform(plan("zoom"))).toBe("scale(1.08)")
    expect(exitTransform(plan("zoom"))).toBe("scale(0.96)")
  })
})

describe("crossfadeToLayer", () => {
  it("stages the incoming image on the hidden layer and flips the phase", () => {
    const el = body()
    const next = crossfadeToLayer({ body: el, cssValue: "url(next.jpg)", plan: plan("crossfade") })

    expect(next).toBe("b")
    expect(el.getAttribute(TRANSITION_ATTRS.phase)).toBe("b")
    expect(el.style.getPropertyValue(TRANSITION_VARS.imageB)).toBe("url(next.jpg)")
    expect(el.getAttribute(ATTR_TWO_LAYER)).toBe("true")
  })

  it("alternates layers across successive advances", () => {
    const el = body()
    crossfadeToLayer({ body: el, cssValue: "url(one.jpg)", plan: plan("crossfade") })
    const third = crossfadeToLayer({ body: el, cssValue: "url(two.jpg)", plan: plan("crossfade") })

    expect(third).toBe("a")
    expect(el.style.getPropertyValue(TRANSITION_VARS.imageA)).toBe("url(two.jpg)")
    // The previous image stays on layer B so it can fade out from it.
    expect(el.style.getPropertyValue(TRANSITION_VARS.imageB)).toBe("url(one.jpg)")
  })

  it("clears the arming attribute so the flip actually animates", () => {
    // Leaving `arming` set would pin `transition: none` and every advance
    // would be an instant cut that still looked correct in a screenshot.
    const el = body()
    crossfadeToLayer({ body: el, cssValue: "url(a.jpg)", plan: plan("crossfade") })
    expect(el.hasAttribute(ATTR_ARMING)).toBe(false)
  })

  it("gives the incoming layer its entry transform and the outgoing its exit", () => {
    const el = body()
    const p = plan("slide", { slideDirection: "up" })
    crossfadeToLayer({ body: el, cssValue: "url(a.jpg)", plan: p })

    expect(el.style.getPropertyValue(transformVarFor("b"))).toBe(entryTransform(p))
    expect(el.style.getPropertyValue(transformVarFor("a"))).toBe(exitTransform(p))
  })

  it("publishes the timing so CSS animates at the configured speed", () => {
    const el = body()
    crossfadeToLayer({
      body: el,
      cssValue: "url(a.jpg)",
      plan: plan("crossfade", { transitionMs: 1200, easing: "easeOut" }),
    })
    expect(el.style.getPropertyValue(TRANSITION_VARS.durationMs)).toBe("1200ms")
    expect(el.style.getPropertyValue(TRANSITION_VARS.easing)).toBe("cubic-bezier(0, 0, 0.2, 1)")
    expect(el.getAttribute(TRANSITION_ATTRS.transition)).toBe("crossfade")
  })
})

describe("normalizeToSingleLayer", () => {
  it("carries the showing image back onto layer A before deleting layer B", () => {
    // The bug this pins: clearing two-layer while phase is "b" deletes the
    // ::after that was painting the wallpaper, blanking the background.
    const el = body()
    crossfadeToLayer({ body: el, cssValue: "url(showing.jpg)", plan: plan("crossfade") })
    expect(currentPhase(el)).toBe("b")

    normalizeToSingleLayer(el)

    expect(currentPhase(el)).toBe("a")
    expect(el.hasAttribute(ATTR_TWO_LAYER)).toBe(false)
    expect(el.style.getPropertyValue(TRANSITION_VARS.imageA)).toBe("url(showing.jpg)")
  })

  it("is a no-op on the image when already on layer A", () => {
    const el = body()
    el.style.setProperty(TRANSITION_VARS.imageA, "url(keep.jpg)")
    normalizeToSingleLayer(el)
    expect(el.style.getPropertyValue(TRANSITION_VARS.imageA)).toBe("url(keep.jpg)")
  })

  it("resets transforms so a re-armed layer does not inherit a stale offset", () => {
    const el = body()
    crossfadeToLayer({ body: el, cssValue: "url(a.jpg)", plan: plan("slide") })
    normalizeToSingleLayer(el)
    expect(el.style.getPropertyValue(TRANSITION_VARS.transformA)).toBe("none")
    expect(el.style.getPropertyValue(TRANSITION_VARS.transformB)).toBe("none")
  })

  it("leaves arming cleared", () => {
    const el = body()
    normalizeToSingleLayer(el)
    expect(el.hasAttribute(ATTR_ARMING)).toBe(false)
  })
})

describe("fadeToImage", () => {
  it("dips opacity, swaps the image, then restores the configured opacity", () => {
    const el = body()
    const timers: Array<() => void> = []
    fadeToImage({
      body: el,
      cssValue: "url(next.jpg)",
      plan: plan("fade", { transitionMs: 400 }),
      opacity: 0.8,
      schedule: (fn) => {
        timers.push(fn)
        return 1
      },
    })

    expect(el.style.getPropertyValue(BG_VARS.opacity)).toBe("0")
    timers[0]()
    expect(el.style.getPropertyValue(TRANSITION_VARS.imageA)).toBe("url(next.jpg)")
    expect(el.style.getPropertyValue(BG_VARS.opacity)).toBe("0.8")
  })

  it("stays on one layer, because it is the fallback when layer B is unavailable", () => {
    const el = body()
    fadeToImage({
      body: el,
      cssValue: "url(next.jpg)",
      plan: plan("fade"),
      opacity: 1,
      schedule: () => 1,
    })
    expect(el.hasAttribute(ATTR_TWO_LAYER)).toBe(false)
  })

  it("cancels a pending restore so a re-advance cannot resurrect an old image", () => {
    const el = body()
    const timers: Array<() => void> = []
    const cancel = fadeToImage({
      body: el,
      cssValue: "url(stale.jpg)",
      plan: plan("fade"),
      opacity: 1,
      schedule: (fn) => {
        timers.push(fn)
        return 1
      },
    })

    cancel()
    timers[0]()
    expect(el.style.getPropertyValue(TRANSITION_VARS.imageA)).toBe("")
    expect(el.style.getPropertyValue(BG_VARS.opacity)).toBe("0")
  })
})

describe("rampDissolveBlur", () => {
  it("bumps blur and restores the user's own value", () => {
    const el = body()
    const timers: Array<() => void> = []
    rampDissolveBlur({
      body: el,
      plan: plan("dissolve", { transitionMs: 800 }),
      restoreBlurPx: 4,
      schedule: (fn) => {
        timers.push(fn)
        return 1
      },
    })

    expect(el.style.getPropertyValue(BG_VARS.blur)).toBe(`${4 + DISSOLVE_BLUR_PX}px`)
    timers[0]()
    expect(el.style.getPropertyValue(BG_VARS.blur)).toBe("4px")
  })

  it("cancels cleanly, leaving the bump for the next advance to resolve", () => {
    const el = body()
    const timers: Array<() => void> = []
    const cancel = rampDissolveBlur({
      body: el,
      plan: plan("dissolve"),
      restoreBlurPx: 0,
      schedule: (fn) => {
        timers.push(fn)
        return 1
      },
    })
    cancel()
    timers[0]()
    expect(el.style.getPropertyValue(BG_VARS.blur)).toBe(`${DISSOLVE_BLUR_PX}px`)
  })
})

describe("writeTransitionTiming", () => {
  it("names the effective transition, not the requested one", () => {
    // Under reduced motion the CSS must see "none", otherwise the Ken Burns
    // keyframes keep running on a user who asked for less motion.
    const el = body()
    const degraded = planTransition({
      rotation: { ...DEFAULT_WALLPAPER_ROTATION, transition: "kenBurns" },
      scrimActive: false,
      reducedMotion: true,
    })
    writeTransitionTiming({ body: el, plan: degraded })
    expect(el.getAttribute(TRANSITION_ATTRS.transition)).toBe("none")
    expect(el.style.getPropertyValue(TRANSITION_VARS.durationMs)).toBe("0ms")
  })
})
