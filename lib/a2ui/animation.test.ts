/**
 * A2UI Animation Utilities Tests
 */

import { ANIMATION_VARIANTS, getAnimationVariants, getTransitionConfig } from "./animation"

describe("ANIMATION_VARIANTS", () => {
  it("should define all expected animation types", () => {
    const expectedTypes = [
      "fadeIn",
      "fadeOut",
      "slideIn",
      "slideOut",
      "scale",
      "bounce",
      "pulse",
      "shake",
      "highlight",
      "none",
    ]
    for (const type of expectedTypes) {
      expect(ANIMATION_VARIANTS).toHaveProperty(type)
      expect(typeof ANIMATION_VARIANTS[type as keyof typeof ANIMATION_VARIANTS]).toBe("function")
    }
  })

  it("fadeIn should return opacity-based variants", () => {
    const variants = ANIMATION_VARIANTS.fadeIn()
    expect(variants.initial).toEqual({ opacity: 0 })
    expect(variants.animate).toEqual({ opacity: 1 })
    expect(variants.exit).toEqual({ opacity: 0 })
  })

  it("fadeOut should return inverse opacity variants", () => {
    const variants = ANIMATION_VARIANTS.fadeOut()
    expect(variants.initial).toEqual({ opacity: 1 })
    expect(variants.animate).toEqual({ opacity: 0 })
  })

  it("slideIn should use direction offsets", () => {
    const up = ANIMATION_VARIANTS.slideIn("up")
    expect(up.initial).toEqual({ opacity: 0, y: 30 })
    expect(up.animate).toEqual({ opacity: 1, x: 0, y: 0 })

    const left = ANIMATION_VARIANTS.slideIn("left")
    expect(left.initial).toEqual({ opacity: 0, x: 30 })

    const down = ANIMATION_VARIANTS.slideIn("down")
    expect(down.initial).toEqual({ opacity: 0, y: -30 })

    const right = ANIMATION_VARIANTS.slideIn("right")
    expect(right.initial).toEqual({ opacity: 0, x: -30 })
  })

  it("slideIn should default to up direction", () => {
    const variants = ANIMATION_VARIANTS.slideIn()
    expect(variants.initial).toEqual({ opacity: 0, y: 30 })
  })

  it("slideOut should use inverse direction offsets", () => {
    const up = ANIMATION_VARIANTS.slideOut("up")
    expect(up.animate).toEqual({ opacity: 0, y: -30 })

    const down = ANIMATION_VARIANTS.slideOut("down")
    expect(down.animate).toEqual({ opacity: 0, y: 30 })
  })

  it("scale should return scale-based variants", () => {
    const variants = ANIMATION_VARIANTS.scale()
    expect(variants.initial).toEqual({ scale: 0, opacity: 0 })
    expect(variants.animate).toEqual({ scale: 1, opacity: 1 })
  })

  it("bounce should return y-axis keyframe animation", () => {
    const variants = ANIMATION_VARIANTS.bounce()
    expect(variants.initial).toEqual({ y: 0 })
    expect((variants.animate as Record<string, unknown>).y).toEqual([0, -10, 0, -5, 0])
  })

  it("pulse should return repeating scale animation", () => {
    const variants = ANIMATION_VARIANTS.pulse()
    expect((variants.animate as Record<string, unknown>).scale).toEqual([1, 1.05, 1])
  })

  it("shake should return x-axis keyframe animation", () => {
    const variants = ANIMATION_VARIANTS.shake()
    expect((variants.animate as Record<string, unknown>).x).toEqual([0, -5, 5, -5, 5, 0])
  })

  it("none should return empty variants", () => {
    const variants = ANIMATION_VARIANTS.none()
    expect(variants.initial).toEqual({})
    expect(variants.animate).toEqual({})
    expect(variants.exit).toEqual({})
  })
})

describe("getAnimationVariants", () => {
  it('should return none variants for type "none"', () => {
    const variants = getAnimationVariants("none")
    expect(variants.initial).toEqual({})
    expect(variants.animate).toEqual({})
  })

  it("should return custom animation when provided", () => {
    const custom = {
      initial: { x: -100 },
      animate: { x: 0 },
      exit: { x: 100 },
    }
    const variants = getAnimationVariants("fadeIn", undefined, custom)
    expect(variants.initial).toEqual({ x: -100 })
    expect(variants.animate).toEqual({ x: 0 })
    expect(variants.exit).toEqual({ x: 100 })
  })

  it("should return custom animation with partial fields", () => {
    const custom = { animate: { rotate: 360 } }
    const variants = getAnimationVariants("fadeIn", undefined, custom)
    expect(variants.initial).toEqual({})
    expect(variants.animate).toEqual({ rotate: 360 })
  })

  it("should return predefined variants for known types", () => {
    const variants = getAnimationVariants("scale")
    expect(variants.initial).toEqual({ scale: 0, opacity: 0 })
    expect(variants.animate).toEqual({ scale: 1, opacity: 1 })
  })

  it("should pass direction to slideIn", () => {
    const variants = getAnimationVariants("slideIn", "left")
    expect(variants.initial).toEqual({ opacity: 0, x: 30 })
  })

  it("should fallback to fadeIn for unknown type", () => {
    const variants = getAnimationVariants("nonExistent" as never)
    expect(variants.initial).toEqual({ opacity: 0 })
    expect(variants.animate).toEqual({ opacity: 1 })
  })
})

describe("getTransitionConfig", () => {
  it("should return default config when called with no args", () => {
    const config = getTransitionConfig()
    expect(config).toEqual({
      duration: 0.5,
      delay: 0,
      ease: "easeOut",
    })
  })

  it("should use provided duration and delay", () => {
    const config = getTransitionConfig(1.2, 0.3)
    expect(config.duration).toBe(1.2)
    expect(config.delay).toBe(0.3)
  })

  it("should add numeric repeat", () => {
    const config = getTransitionConfig(0.5, 0, 3)
    expect(config.repeat).toBe(3)
  })

  it('should convert "infinite" repeat to Infinity', () => {
    const config = getTransitionConfig(0.5, 0, "infinite")
    expect(config.repeat).toBe(Infinity)
  })

  it("should not include repeat when undefined", () => {
    const config = getTransitionConfig(0.5, 0)
    expect(config).not.toHaveProperty("repeat")
  })

  it("should merge custom transition properties", () => {
    const config = getTransitionConfig(0.5, 0, undefined, { ease: "linear", stiffness: 100 })
    expect(config.ease).toBe("linear")
    expect(config.stiffness).toBe(100)
    expect(config.duration).toBe(0.5)
  })

  it("should allow custom transition to override defaults", () => {
    const config = getTransitionConfig(0.5, 0, undefined, { duration: 2 })
    expect(config.duration).toBe(2)
  })
})
