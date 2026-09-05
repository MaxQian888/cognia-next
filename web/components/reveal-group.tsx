"use client"

import { motion } from "motion/react"
import { useReducedMotion } from "motion/react"
import { createElement, type CSSProperties, type ReactNode } from "react"
import { EASE_ENTRANCE } from "@web/lib/motion"

/**
 * The longest a whole group may take to finish arriving.
 *
 * A fixed per-item delay does not survive contact with the capability grids,
 * which run to nine cells: at 60ms each the last one lands 540ms after the
 * first, which reads as the page struggling rather than as craft. The stagger
 * is divided down to fit this budget once a group is large enough.
 */
const MAX_CASCADE_S = 0.32

/**
 * The elements a group or item may render as.
 *
 * A closed set rather than `ElementType` on purpose: the component has to be
 * looked up as `motion[tag]`, never built with `motion.create(tag)` inside
 * render. `motion.create` mints a new component *type* on every render, and
 * React unmounts and remounts the whole subtree when a type changes — which
 * would drop focus and restart the very animation this exists to run. Indexing
 * the proxy is cached by both `motion/react` and the repo's shared Jest mock.
 *
 * Kept to the tags the site actually reveals — the list semantics the grids
 * need, plus the default `div`. Widen it when a surface needs another one, not
 * in advance.
 */
export type RevealTag = "div" | "ul" | "ol" | "li" | "dl"

const MOTION_TAG = {
  div: motion.div,
  ul: motion.ul,
  ol: motion.ol,
  li: motion.li,
  dl: motion.dl,
} as const satisfies Record<RevealTag, unknown>

interface RevealGroupProps {
  children: ReactNode
  className?: string
  /**
   * The element to render. This matters more than it looks: the site's grids
   * are semantic `<ul>`/`<ol>`/`<dl>`, and silently wrapping them in a `<div>`
   * would drop the list semantics several suites assert on — and that screen
   * readers use to announce "list, 4 items".
   */
  as?: RevealTag
  /** Per-item delay in seconds, before the cascade cap is applied. */
  stagger?: number
  /** How many children the cascade must cover. Used to apply the cap. */
  count?: number
}

/**
 * **Sequence** — a group whose children arrive one after another (ADR-0092 §6).
 *
 * `Reveal` moves one block; this moves a set, and the offset between them is
 * what makes a grid read as a list of records being laid down rather than as a
 * slab appearing. Same curve, same `once`, same reduced-motion contract.
 *
 * Under `prefers-reduced-motion` no motion component mounts at all — the plain
 * element renders with its children in their final state, exactly as `Reveal`
 * does. A shortened animation is not the fallback; no animation is.
 */
export function RevealGroup({
  children,
  className,
  as = "div",
  stagger = 0.06,
  count,
}: RevealGroupProps) {
  const reduced = useReducedMotion()

  if (reduced) {
    return createElement(as, { className }, children)
  }

  const effective = count && count > 1 ? Math.min(stagger, MAX_CASCADE_S / (count - 1)) : stagger

  const Component = MOTION_TAG[as]

  return (
    <Component
      className={className}
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.15 }}
      variants={{
        hidden: {},
        visible: { transition: { staggerChildren: effective, delayChildren: 0.05 } },
      }}
    >
      {children}
    </Component>
  )
}

interface RevealItemProps {
  children: ReactNode
  className?: string
  style?: CSSProperties
  as?: RevealTag
  /** Set on a purely visual member, such as a grid's filler reconstruction. */
  "aria-hidden"?: boolean
  "data-slot"?: string
}

/**
 * One member of a {@link RevealGroup}. Inherits its timing from the parent's
 * `staggerChildren`, so an item never states its own delay and the cascade
 * stays correct when items are added or removed.
 */
export function RevealItem({
  children,
  className,
  style,
  as = "div",
  "aria-hidden": ariaHidden,
  "data-slot": dataSlot,
}: RevealItemProps) {
  const reduced = useReducedMotion()

  if (reduced) {
    return createElement(
      as,
      { className, style, "aria-hidden": ariaHidden, "data-slot": dataSlot },
      children
    )
  }

  const Component = MOTION_TAG[as]

  return (
    <Component
      data-reveal-item=""
      aria-hidden={ariaHidden}
      data-slot={dataSlot}
      className={className}
      style={style}
      variants={{
        hidden: { opacity: 0, y: 10 },
        visible: { opacity: 1, y: 0 },
      }}
      transition={{ duration: 0.45, ease: EASE_ENTRANCE }}
    >
      {children}
    </Component>
  )
}
