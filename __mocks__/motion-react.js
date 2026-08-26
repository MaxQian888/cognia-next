/**
 * Jest mock for `motion/react` (the modern alias of framer-motion).
 *
 * The real animation library doesn't synchronously write the `animate`
 * target into the rendered element's inline style under jsdom — there's
 * no animation loop driving the styles to their targets. Tests that
 * assert `expect(wrapper).toHaveStyle({ opacity: "0" })` need the
 * animate prop to land as inline style on the first render.
 *
 * This mock replaces each `motion.<tag>` with a plain React element of
 * the same tag. The `animate` prop is merged into the `style` prop so
 * inline-style assertions work synchronously. Layout / variant / drag /
 * gesture props are stripped — tests asserting on those would need a
 * richer mock, but no current suite does.
 */
"use strict"

const React = require("react")

const MOTION_ONLY_PROPS = new Set([
  "animate",
  "initial",
  "exit",
  "transition",
  "variants",
  "whileHover",
  "whileTap",
  "whileFocus",
  "whileDrag",
  "whileInView",
  "drag",
  "dragConstraints",
  "dragElastic",
  "dragMomentum",
  "dragTransition",
  "layout",
  "layoutId",
  "layoutDependency",
  "layoutScroll",
  "layoutRoot",
  "onAnimationStart",
  "onAnimationComplete",
  "onUpdate",
  "onHoverStart",
  "onHoverEnd",
  "onTapStart",
  "onTap",
  "onTapCancel",
  "onPan",
  "onPanStart",
  "onPanEnd",
  "onDrag",
  "onDragStart",
  "onDragEnd",
  "onDragTransitionEnd",
])

function isAnimatableObject(v) {
  return v && typeof v === "object" && !Array.isArray(v)
}

function makeMotionComponent(tag) {
  const Component = React.forwardRef(function MotionMock(props, ref) {
    const { animate, initial, style, children, ...rest } = props
    // Strip every motion-only prop so React doesn't warn about unknown
    // DOM attributes.
    const cleaned = {}
    for (const key of Object.keys(rest)) {
      if (!MOTION_ONLY_PROPS.has(key)) {
        cleaned[key] = rest[key]
      }
    }
    // Compose inline style: `style` wins over the animate target so
    // explicit per-render style overrides still apply. We coerce common
    // CSS values (numbers → strings) the way framer-motion would.
    const animateStyle = isAnimatableObject(animate) ? animate : {}
    const initialStyle = isAnimatableObject(initial) ? initial : {}
    const merged = { ...initialStyle, ...animateStyle, ...(style || {}) }
    return React.createElement(tag, { ref, ...cleaned, style: merged }, children)
  })
  Component.displayName = `MotionMock(${tag})`
  return Component
}

function wrapCustomComponent(Component) {
  return React.forwardRef(function MotionCreated(props, ref) {
    const { animate, initial, style, ...rest } = props
    const animateStyle = isAnimatableObject(animate) ? animate : {}
    const initialStyle = isAnimatableObject(initial) ? initial : {}
    // Strip motion-only props so they don't leak onto the underlying
    // component (e.g. a Next.js Link will warn if it sees unknown props).
    const cleaned = {}
    for (const key of Object.keys(rest)) {
      if (!MOTION_ONLY_PROPS.has(key)) {
        cleaned[key] = rest[key]
      }
    }
    const merged = { ...initialStyle, ...animateStyle, ...(style || {}) }
    return React.createElement(Component, { ref, ...cleaned, style: merged })
  })
}

// Cache component identities per tag so each `motion.div` access returns
// the same React component. Otherwise every render would mint a new
// component type and React would unmount the subtree, which silently
// drops focus / state / input keystrokes mid-test.
const motionComponentCache = new Map()
function getMotionComponent(tag) {
  let cached = motionComponentCache.get(tag)
  if (!cached) {
    cached = makeMotionComponent(tag)
    motionComponentCache.set(tag, cached)
  }
  return cached
}

const motion = new Proxy(
  {
    // `motion.create(C)` produces a motion-enhanced version of `C`. The
    // real implementation hooks up animate/layout/etc.; the mock just
    // merges `animate` into `style` like the tag proxies above.
    create: wrapCustomComponent,
  },
  {
    get(target, prop) {
      if (prop === "create") return target.create
      if (typeof prop === "string") {
        return getMotionComponent(prop)
      }
      return undefined
    },
  }
)

function AnimatePresence({ children }) {
  return children
}

function LazyMotion({ children }) {
  return children
}

// Namespaces the `layoutId`s beneath it in the real library; here there is no
// layout projection to namespace, so it is a pass-through like the wrappers
// above. It still has to EXIST — rendering `undefined` as a component is a
// hard React error, not a degraded animation.
function LayoutGroup({ children }) {
  return children
}

const noopMotionValue = (initial) => {
  const value = { current: initial }
  return {
    get: () => value.current,
    set: (next) => {
      value.current = next
    },
    on: () => () => undefined,
    destroy: () => undefined,
  }
}

module.exports = {
  motion,
  m: motion,
  AnimatePresence,
  LazyMotion,
  LayoutGroup,
  MotionConfig: ({ children }) => children,
  useAnimation: () => ({
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(),
    set: jest.fn(),
  }),
  useAnimationControls: () => ({
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn(),
    set: jest.fn(),
  }),
  useMotionValue: noopMotionValue,
  useTransform: () => noopMotionValue(),
  useSpring: () => noopMotionValue(),
  useScroll: () => ({ scrollX: noopMotionValue(0), scrollY: noopMotionValue(0) }),
  useReducedMotion: () => false,
  useInView: () => true,
  useIsPresent: () => true,
  domAnimation: {},
  domMax: {},
}
