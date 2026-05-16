/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"
import {
  MOBILE_DURATION,
  MOBILE_EASE,
  STAGGER_CHILD,
  STAGGER_CONTAINER,
  STAGGER_INTERVAL,
  mobileTransition,
  useReducedMotionTransition,
  useReducedMotionVariants,
} from "./motion"

const reduceMotionRef = { current: false }

jest.mock("motion/react", () => ({
  useReducedMotion: () => reduceMotionRef.current,
}))

beforeEach(() => {
  reduceMotionRef.current = false
})

describe("mobile motion tokens", () => {
  it("MOBILE_EASE is a 4-tuple cubic-bezier", () => {
    expect(MOBILE_EASE).toHaveLength(4)
    expect(MOBILE_EASE.every((n) => typeof n === "number")).toBe(true)
  })

  it("MOBILE_DURATION exposes fast/normal/slow ordering", () => {
    expect(MOBILE_DURATION.fast).toBeLessThan(MOBILE_DURATION.normal)
    expect(MOBILE_DURATION.normal).toBeLessThan(MOBILE_DURATION.slow)
  })

  it("STAGGER_CHILD declares enter and exit states", () => {
    expect(STAGGER_CHILD.initial).toMatchObject({ opacity: 0, y: 8 })
    expect(STAGGER_CHILD.animate).toMatchObject({ opacity: 1, y: 0 })
    expect(STAGGER_CHILD.exit).toMatchObject({ opacity: 0, y: 8 })
  })

  it("STAGGER_CONTAINER nests staggerChildren under animate.transition", () => {
    const animate = STAGGER_CONTAINER.animate as { transition: { staggerChildren: number } }
    expect(animate.transition.staggerChildren).toBe(STAGGER_INTERVAL)
  })
})

describe("mobileTransition()", () => {
  it("defaults to the normal duration", () => {
    const t = mobileTransition()
    expect(t.duration).toBe(MOBILE_DURATION.normal)
  })

  it("honours an explicit duration key", () => {
    expect(mobileTransition("fast").duration).toBe(MOBILE_DURATION.fast)
    expect(mobileTransition("slow").duration).toBe(MOBILE_DURATION.slow)
  })

  it("carries the shared ease curve", () => {
    const t = mobileTransition()
    expect(t.ease).toEqual(MOBILE_EASE)
  })
})

describe("useReducedMotionVariants()", () => {
  it("passes variants through when reduced motion is off", () => {
    reduceMotionRef.current = false
    const variants = { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    const { result } = renderHook(() => useReducedMotionVariants(variants))
    expect(result.current).toBe(variants)
  })

  it("collapses to the animate state when reduced motion is on", () => {
    reduceMotionRef.current = true
    const variants = { initial: { opacity: 0, y: 8 }, animate: { opacity: 1, y: 0 } }
    const { result } = renderHook(() => useReducedMotionVariants(variants))
    expect(result.current.initial).toEqual({ opacity: 1, y: 0 })
    expect(result.current.animate).toEqual({ opacity: 1, y: 0 })
    expect(result.current.exit).toEqual({ opacity: 1, y: 0 })
  })

  it("falls back to an empty object when no animate state is supplied", () => {
    reduceMotionRef.current = true
    const { result } = renderHook(() => useReducedMotionVariants({}))
    expect(result.current.initial).toEqual({})
    expect(result.current.animate).toEqual({})
    expect(result.current.exit).toEqual({})
  })
})

describe("useReducedMotionTransition()", () => {
  it("passes the transition through when reduced motion is off", () => {
    reduceMotionRef.current = false
    const transition = { duration: 0.4, ease: "easeOut" }
    const { result } = renderHook(() => useReducedMotionTransition(transition))
    expect(result.current).toBe(transition)
  })

  it("returns a zero-duration transition when reduced motion is on", () => {
    reduceMotionRef.current = true
    const { result } = renderHook(() => useReducedMotionTransition({ duration: 0.4 }))
    expect(result.current).toEqual({ duration: 0 })
  })
})
