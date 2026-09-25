/**
 * @jest-environment jsdom
 */
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { act, renderHook } from "@testing-library/react"

import {
  MOBILE_DURATION,
  MOBILE_EASE,
  MOBILE_SPRING,
  MOTION_RESPECT_ATTRIBUTE,
  REDUCE_MOTION_ATTRIBUTE,
  REDUCE_MOTION_CLASS,
  REDUCED_MOTION_QUERY,
  STAGGER_CHILD,
  STAGGER_CONTAINER,
  STAGGER_DELAY_CHILDREN,
  STAGGER_INTERVAL,
  STAGGER_MAX_SPREAD,
  mobileTransition,
  readReducedMotion,
  staggerContainerFor,
  staggerIntervalFor,
  subscribeReducedMotion,
  useReducedMotionTransition,
  useReducedMotionVariants,
  useShouldReduceMotion,
} from "./motion-tokens"

/*
 * Reduced motion is driven through the real DOM markers and a controllable
 * `matchMedia`, not a mocked library hook: the markers ARE the contract with
 * the host (motion-applier's class, SettingsSyncProvider's attribute, and the
 * `data-motion-respect="off"` opt-out that globals.css honours), so a test that
 * stubbed the hook would pass while the wiring to those markers was broken.
 */
const root = () => document.documentElement
const originalMatchMedia = window.matchMedia

/** A matchMedia whose `(prefers-reduced-motion)` answer the test can flip and broadcast. */
function stubOsPreference(initial: boolean) {
  const state = { matches: initial }
  const listeners = new Set<() => void>()
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === REDUCED_MOTION_QUERY && state.matches
    },
    media: query,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  })) as unknown as typeof window.matchMedia
  return {
    listenerCount: () => listeners.size,
    set(matches: boolean) {
      state.matches = matches
      for (const listener of Array.from(listeners)) listener()
    },
  }
}

afterEach(() => {
  root().className = ""
  root().removeAttribute(REDUCE_MOTION_ATTRIBUTE)
  root().removeAttribute(MOTION_RESPECT_ATTRIBUTE)
  window.matchMedia = originalMatchMedia
  jest.restoreAllMocks()
})

/**
 * These numbers are the app's animation identity: the host imports them
 * through `@/lib/ui/motion` and plugins get them through `motionTokens`. A
 * silent edit here would desynchronise a plugin panel from the host panel next
 * to it, so pin the shape and the ordering rather than trusting review.
 */
describe("tokens", () => {
  it("MOBILE_EASE is a 4-point cubic-bezier", () => {
    expect(MOBILE_EASE).toHaveLength(4)
    expect(MOBILE_EASE.every((n) => typeof n === "number")).toBe(true)
  })

  it("MOBILE_DURATION is ordered and expressed in seconds", () => {
    expect(MOBILE_DURATION.fast).toBeLessThan(MOBILE_DURATION.normal)
    expect(MOBILE_DURATION.normal).toBeLessThan(MOBILE_DURATION.slow)
    // motion/react takes seconds; a millisecond value would run ~1000x long.
    expect(MOBILE_DURATION.slow).toBeLessThan(1)
  })

  it("MOBILE_SPRING settles without overshooting", () => {
    const { type, stiffness, damping, mass } = MOBILE_SPRING as {
      type: string
      stiffness: number
      damping: number
      mass: number
    }
    expect(type).toBe("spring")
    // Critically damped or stiffer: damping >= 2*sqrt(stiffness*mass) means no
    // visible bounce. A bouncy selection indicator reads as a toy, and the
    // overshoot would push the pill past the tab it is meant to land on.
    expect(damping).toBeGreaterThanOrEqual(2 * Math.sqrt(stiffness * mass))
  })

  it("STAGGER_CHILD fades and rises, and returns the way it came", () => {
    expect(STAGGER_CHILD.initial).toMatchObject({ opacity: 0, y: 8 })
    expect(STAGGER_CHILD.animate).toMatchObject({ opacity: 1, y: 0 })
    expect(STAGGER_CHILD.exit).toEqual(STAGGER_CHILD.initial)
  })

  it("STAGGER_CONTAINER paces its children at STAGGER_INTERVAL", () => {
    const animate = STAGGER_CONTAINER.animate as { transition: { staggerChildren: number } }
    expect(animate.transition.staggerChildren).toBe(STAGGER_INTERVAL)
  })
})

describe("mobileTransition()", () => {
  it("defaults to the normal duration", () => {
    expect(mobileTransition().duration).toBe(MOBILE_DURATION.normal)
  })

  it("honours an explicit duration key", () => {
    expect(mobileTransition("fast").duration).toBe(MOBILE_DURATION.fast)
    expect(mobileTransition("slow").duration).toBe(MOBILE_DURATION.slow)
  })

  it("always carries the shared ease curve", () => {
    expect(mobileTransition("slow").ease).toEqual(MOBILE_EASE)
  })
})

describe("stagger cap", () => {
  it("keeps the standard interval for short lists", () => {
    expect(staggerIntervalFor(1)).toBe(STAGGER_INTERVAL)
    expect(staggerIntervalFor(2)).toBe(STAGGER_INTERVAL)
    // 6 children at 40ms span exactly the 0.2s budget — still uncapped.
    expect(staggerIntervalFor(6)).toBe(STAGGER_INTERVAL)
  })

  it.each([7, 8, 20, 50, 500])(
    "spreads the starts of %i children over no more than STAGGER_MAX_SPREAD",
    (count) => {
      const interval = staggerIntervalFor(count)
      expect(interval).toBeLessThan(STAGGER_INTERVAL)
      expect(interval * (count - 1)).toBeLessThanOrEqual(STAGGER_MAX_SPREAD + 1e-9)
    }
  )

  it("keeps the whole reveal (delay + spread) within ~0.25s", () => {
    expect(STAGGER_DELAY_CHILDREN + STAGGER_MAX_SPREAD).toBeLessThanOrEqual(0.25)
  })

  it("treats a non-finite count as a short list", () => {
    expect(staggerIntervalFor(Number.NaN)).toBe(STAGGER_INTERVAL)
    expect(staggerIntervalFor(0)).toBe(STAGGER_INTERVAL)
  })

  it("hands back the shared container itself when the cap does not bite", () => {
    expect(staggerContainerFor(3)).toBe(STAGGER_CONTAINER)
  })

  it("builds a tightened container for long lists", () => {
    const variants = staggerContainerFor(51)
    const animate = variants.animate as {
      transition: { staggerChildren: number; delayChildren: number }
    }
    expect(animate.transition.staggerChildren).toBeCloseTo(STAGGER_MAX_SPREAD / 50, 10)
    expect(animate.transition.delayChildren).toBe(STAGGER_DELAY_CHILDREN)
    expect(variants.initial).toEqual({})
  })
})

describe("readReducedMotion()", () => {
  it("animates when no marker is present and the OS says nothing", () => {
    stubOsPreference(false)
    expect(readReducedMotion()).toBe(false)
  })

  it("reduces for the in-app class (motion-applier)", () => {
    root().classList.add(REDUCE_MOTION_CLASS)
    expect(readReducedMotion()).toBe(true)
  })

  it('reduces for data-reduce-motion="true" (SettingsSyncProvider)', () => {
    root().setAttribute(REDUCE_MOTION_ATTRIBUTE, "true")
    expect(readReducedMotion()).toBe(true)
  })

  it('matches the CSS guard exactly: only the value "true" counts', () => {
    root().setAttribute(REDUCE_MOTION_ATTRIBUTE, "false")
    expect(readReducedMotion()).toBe(false)
  })

  it("reduces for the OS hint", () => {
    stubOsPreference(true)
    expect(readReducedMotion()).toBe(true)
  })

  it('ignores the OS hint when data-motion-respect="off"', () => {
    stubOsPreference(true)
    root().setAttribute(MOTION_RESPECT_ATTRIBUTE, "off")
    expect(readReducedMotion()).toBe(false)
  })

  it("never lets the respect opt-out override an explicit app opt-in", () => {
    stubOsPreference(false)
    root().setAttribute(MOTION_RESPECT_ATTRIBUTE, "off")
    root().classList.add(REDUCE_MOTION_CLASS)
    expect(readReducedMotion()).toBe(true)
    root().classList.remove(REDUCE_MOTION_CLASS)
    root().setAttribute(REDUCE_MOTION_ATTRIBUTE, "true")
    expect(readReducedMotion()).toBe(true)
  })

  it("keeps animating when matchMedia throws", () => {
    window.matchMedia = (() => {
      throw new Error("not implemented")
    }) as unknown as typeof window.matchMedia
    expect(readReducedMotion()).toBe(false)
  })
})

describe("subscribeReducedMotion()", () => {
  it("shares one <html> observer across subscribers and tears it down with the last", () => {
    const observe = jest.spyOn(MutationObserver.prototype, "observe")
    const disconnect = jest.spyOn(MutationObserver.prototype, "disconnect")
    const os = stubOsPreference(false)

    const stopA = subscribeReducedMotion(() => {})
    const stopB = subscribeReducedMotion(() => {})
    expect(observe).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledWith(root(), {
      attributes: true,
      attributeFilter: ["class", REDUCE_MOTION_ATTRIBUTE, MOTION_RESPECT_ATTRIBUTE],
    })
    expect(os.listenerCount()).toBe(1)

    stopA()
    expect(disconnect).not.toHaveBeenCalled()
    stopB()
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(os.listenerCount()).toBe(0)

    // A later subscriber starts observing again rather than inheriting a dead observer.
    const stopC = subscribeReducedMotion(() => {})
    expect(observe).toHaveBeenCalledTimes(2)
    stopC()
  })

  it("notifies on a marker change and on an OS preference change", async () => {
    const os = stubOsPreference(false)
    const onChange = jest.fn()
    const stop = subscribeReducedMotion(onChange)

    root().setAttribute(REDUCE_MOTION_ATTRIBUTE, "true")
    // MutationObserver delivers on a microtask.
    await Promise.resolve()
    expect(onChange).toHaveBeenCalledTimes(1)

    os.set(true)
    expect(onChange).toHaveBeenCalledTimes(2)

    stop()
    root().classList.add(REDUCE_MOTION_CLASS)
    await Promise.resolve()
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it("counts the same callback subscribed twice as two subscriptions", () => {
    const disconnect = jest.spyOn(MutationObserver.prototype, "disconnect")
    const onChange = () => {}
    const stopA = subscribeReducedMotion(onChange)
    const stopB = subscribeReducedMotion(onChange)
    stopA()
    expect(disconnect).not.toHaveBeenCalled()
    stopB()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })
})

describe("useShouldReduceMotion()", () => {
  it("follows the in-app class being toggled at runtime", async () => {
    const { result } = renderHook(() => useShouldReduceMotion())
    expect(result.current).toBe(false)

    await act(async () => {
      root().classList.add(REDUCE_MOTION_CLASS)
    })
    expect(result.current).toBe(true)

    await act(async () => {
      root().classList.remove(REDUCE_MOTION_CLASS)
    })
    expect(result.current).toBe(false)
  })

  it("follows the respect opt-out being written after mount", async () => {
    stubOsPreference(true)
    const { result } = renderHook(() => useShouldReduceMotion())
    expect(result.current).toBe(true)

    await act(async () => {
      root().setAttribute(MOTION_RESPECT_ATTRIBUTE, "off")
    })
    expect(result.current).toBe(false)
  })

  it("follows the OS preference changing after mount", () => {
    const os = stubOsPreference(false)
    const { result } = renderHook(() => useShouldReduceMotion())
    expect(result.current).toBe(false)

    act(() => os.set(true))
    expect(result.current).toBe(true)
  })

  it("renders not-reduced on the server, whatever the client markers say", () => {
    root().classList.add(REDUCE_MOTION_CLASS)
    function Probe() {
      return createElement("span", null, String(useShouldReduceMotion()))
    }
    expect(renderToString(createElement(Probe))).toContain("false")
  })
})

describe("useReducedMotionVariants()", () => {
  const variants = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } }
  const settled = {
    initial: { opacity: 1, y: 0 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 1, y: 0 },
  }

  it("passes variants through untouched when motion is allowed", () => {
    const full = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    const { result } = renderHook(() => useReducedMotionVariants(full))
    expect(result.current).toBe(full)
  })

  it("snaps every state to the settled one under the app class", () => {
    root().classList.add(REDUCE_MOTION_CLASS)
    const { result } = renderHook(() => useReducedMotionVariants(variants))
    expect(result.current).toEqual(settled)
  })

  it("snaps every state to the settled one under data-reduce-motion", () => {
    root().setAttribute(REDUCE_MOTION_ATTRIBUTE, "true")
    const { result } = renderHook(() => useReducedMotionVariants(variants))
    expect(result.current).toEqual(settled)
  })

  it("snaps under the OS hint", () => {
    stubOsPreference(true)
    const { result } = renderHook(() => useReducedMotionVariants(variants))
    expect(result.current).toEqual(settled)
  })

  it('keeps animating under the OS hint when data-motion-respect="off"', () => {
    stubOsPreference(true)
    root().setAttribute(MOTION_RESPECT_ATTRIBUTE, "off")
    const { result } = renderHook(() => useReducedMotionVariants(variants))
    expect(result.current).toBe(variants)
  })

  it("flips when the app class is toggled at runtime", async () => {
    const { result } = renderHook(() => useReducedMotionVariants(variants))
    expect(result.current).toBe(variants)
    await act(async () => {
      root().classList.add(REDUCE_MOTION_CLASS)
    })
    expect(result.current).toEqual(settled)
  })

  it("falls back to empty states when no settled state was supplied", () => {
    root().classList.add(REDUCE_MOTION_CLASS)
    const { result } = renderHook(() => useReducedMotionVariants({}))
    expect(result.current).toEqual({ initial: {}, animate: {}, exit: {} })
  })
})

describe("useReducedMotionTransition()", () => {
  it("passes the transition through when motion is allowed", () => {
    const transition = { duration: 0.4, ease: "easeOut" as const }
    const { result } = renderHook(() => useReducedMotionTransition(transition))
    expect(result.current).toBe(transition)
  })

  it("collapses to zero duration under either app marker", () => {
    root().classList.add(REDUCE_MOTION_CLASS)
    expect(renderHook(() => useReducedMotionTransition({ duration: 0.4 })).result.current).toEqual({
      duration: 0,
    })
    root().classList.remove(REDUCE_MOTION_CLASS)
    root().setAttribute(REDUCE_MOTION_ATTRIBUTE, "true")
    expect(renderHook(() => useReducedMotionTransition({ duration: 0.4 })).result.current).toEqual({
      duration: 0,
    })
  })

  it('does not collapse for the OS hint when data-motion-respect="off"', () => {
    stubOsPreference(true)
    root().setAttribute(MOTION_RESPECT_ATTRIBUTE, "off")
    const transition = { duration: 0.4 }
    const { result } = renderHook(() => useReducedMotionTransition(transition))
    expect(result.current).toBe(transition)
  })

  it("flips when the app class is toggled at runtime", async () => {
    const transition = { duration: 0.4 }
    const { result } = renderHook(() => useReducedMotionTransition(transition))
    expect(result.current).toBe(transition)
    await act(async () => {
      root().classList.add(REDUCE_MOTION_CLASS)
    })
    expect(result.current).toEqual({ duration: 0 })
  })
})
