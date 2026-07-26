/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

import {
  MOBILE_DURATION,
  MOBILE_EASE,
  MOBILE_SPRING,
  STAGGER_CHILD,
  STAGGER_CONTAINER,
  STAGGER_INTERVAL,
  mobileTransition,
  useReducedMotionTransition,
  useReducedMotionVariants,
} from "./motion-tokens"

// The library's own hook only sees the OS media query; drive it directly so
// both branches are exercised without touching global matchMedia state.
const reduceMotionRef = { current: false }

jest.mock("motion/react", () => ({
  useReducedMotion: () => reduceMotionRef.current,
}))

beforeEach(() => {
  reduceMotionRef.current = false
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

describe("useReducedMotionVariants()", () => {
  it("passes variants through untouched when motion is allowed", () => {
    const variants = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    const { result } = renderHook(() => useReducedMotionVariants(variants))
    expect(result.current).toBe(variants)
  })

  it("snaps every state to the settled one when motion is reduced", () => {
    reduceMotionRef.current = true
    const variants = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } }
    const { result } = renderHook(() => useReducedMotionVariants(variants))
    expect(result.current).toEqual({
      initial: { opacity: 1, y: 0 },
      animate: { opacity: 1, y: 0 },
      exit: { opacity: 1, y: 0 },
    })
  })

  it("falls back to empty states when no settled state was supplied", () => {
    reduceMotionRef.current = true
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

  it("collapses to zero duration when motion is reduced", () => {
    reduceMotionRef.current = true
    const { result } = renderHook(() => useReducedMotionTransition({ duration: 0.4 }))
    expect(result.current).toEqual({ duration: 0 })
  })
})
