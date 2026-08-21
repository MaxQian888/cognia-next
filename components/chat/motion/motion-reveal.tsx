"use client"

/**
 * Lightweight motion primitives for the agent-flow surfaces.
 *
 * `MotionReveal` plays a one-shot entrance (fade + small translateY) when a
 * card/row first mounts — newly streamed tool calls slide in instead of
 * popping. It is deliberately GPU-friendly (only `opacity` + `transform`, no
 * layout animation, no backdrop-filter) so a tool-dense reply doesn't pay a
 * per-frame compositing cost while scrolling — the same constraint the static
 * `Tool` card honours.
 *
 * Motion respects user preferences: it collapses to a plain wrapper when the
 * appearance `motion.reduce` flag is set OR the OS `prefers-reduced-motion`
 * hint is on, and scales duration by `durationScale` — the same multiplier the
 * global `--motion-duration-scale` var carries, derived from the user's speed
 * preference through the one shared `speedToDurationScale`.
 */

import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { createContext, useContext, type CSSProperties, type ReactNode } from "react"

import { useSettingsStore } from "@/stores/settings"
import { speedToDurationScale } from "@/lib/appearance/motion-applier"
import { MOBILE_DURATION, MOBILE_EASE, MOBILE_SPRING } from "@/lib/ui/motion"
import type { MessageMotion } from "@/types/appearance"

const MessageMotionContext = createContext<MessageMotion | undefined>(undefined)

export function MessageMotionProvider({
  motion: messageMotion,
  children,
}: {
  motion: MessageMotion
  children: ReactNode
}) {
  return (
    <MessageMotionContext.Provider value={messageMotion}>{children}</MessageMotionContext.Provider>
  )
}

export interface FlowMotion {
  /** True when all motion should be suppressed (user opt-in or OS hint). */
  reduce: boolean
  /**
   * Duration multiplier — matches `--motion-duration-scale`. Multiply a base
   * duration by it; do NOT use the raw `motion.speed` preference, which is its
   * reciprocal (1.5× *speed* means 0.667× *duration*). Exposing only this
   * direction is deliberate: the two were previously conflated, which inverted
   * every JS-side animation exactly as it inverted the CSS ones.
   */
  durationScale: number
}

/** Resolve the active motion preference for the agent-flow surfaces. */
export function useFlowMotion(): FlowMotion {
  const osReduce = useReducedMotion()
  const motionPref = useSettingsStore((s) => s.settings?.motion)
  const messageMotion = useContext(MessageMotionContext)
  return {
    reduce: messageMotion === "off" || osReduce === true || (motionPref?.reduce ?? false),
    durationScale: speedToDurationScale(motionPref?.speed),
  }
}

export interface MotionRevealProps {
  children: ReactNode
  /** Stagger index — later items reveal slightly after earlier ones (capped). */
  index?: number
  className?: string
  /** Force-disable the animation regardless of preference. */
  disabled?: boolean
  /** Restrained is the message default; expressive keeps the spring accent. */
  intensity?: "restrained" | "expressive"
}

export function MotionReveal({
  children,
  index = 0,
  className,
  disabled,
  intensity = "restrained",
}: MotionRevealProps) {
  const { reduce, durationScale } = useFlowMotion()

  if (disabled || reduce) {
    return className ? <div className={className}>{children}</div> : <>{children}</>
  }

  // Staggered spring entrance — newly streamed cards/rows settle in with a
  // little bounce instead of a flat fade. Damping carries the pace: dividing by
  // `durationScale` means a *faster* preference raises damping (snappier, no
  // overshoot) and a slower one lowers it (a longer, lazier settle). At the 1×
  // default this is damping 30 against stiffness 320 — just under critical, so
  // the intended hint of bounce survives unchanged.
  const delay = Math.min(Math.max(index, 0), 6) * 0.03
  const transition =
    intensity === "expressive"
      ? {
          delay,
          type: "spring" as const,
          stiffness: 320,
          damping: 30 / durationScale,
          opacity: { duration: 0.18 * durationScale, ease: "easeOut" as const, delay },
        }
      : {
          delay: Math.min(delay, 0.06),
          duration: 0.16 * durationScale,
          ease: "easeOut" as const,
        }

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: intensity === "expressive" ? 6 : 3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
    >
      {children}
    </motion.div>
  )
}

export interface MotionCollapseProps {
  /** When true the body is shown (and animates in); false animates it out. */
  open: boolean
  children: ReactNode
  className?: string
}

/**
 * Unified expand/collapse for the agent-flow surfaces — the tool rows, the
 * activity group, and the sub-agent rows all reveal their bodies the same way.
 * Collapses to a plain show/hide when motion is reduced (OS hint or user opt-in).
 *
 * Height animates on a *monotonic* eased tween rather than a spring: a spring
 * overshoots `auto`, and under `overflow: hidden` that overshoot clips the last
 * rows of content for a frame. A 0→auto tween never exceeds the final height, so
 * the body is never clipped. `MOBILE_EASE` is monotonic, so it satisfies that
 * constraint while putting this on the same clock as every other surface —
 * before, this was a fourth hand-tuned curve. Opacity keeps its quick ease-out.
 */
export function MotionCollapse({ open, children, className }: MotionCollapseProps) {
  const { reduce, durationScale } = useFlowMotion()

  if (reduce) {
    return open ? <div className={className}>{children}</div> : null
  }

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key="collapse-body"
          className={className}
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{
            height: { duration: MOBILE_DURATION.normal * durationScale, ease: MOBILE_EASE },
            opacity: { duration: MOBILE_DURATION.fast * durationScale, ease: "easeOut" },
          }}
          style={{ overflow: "hidden" }}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}

/**
 * The reading area's disclosure — {@link MotionCollapse} without the height.
 *
 * ADR-0138: inside the transcript, motion may only touch `opacity` and
 * `transform`. Every row there is watched by a `ResizeObserver` (the
 * virtualizer's `measureElement`, and the content observer behind
 * `useStickToBottom`), so a 280 ms height tween is not one layout change — it is
 * one per frame for the length of the animation, each re-publishing the
 * virtualizer's offsets and re-pinning the scroll. A tool card opening halfway
 * up a long reply therefore drags every row below it, frame by frame, and that
 * churn lands on the same main thread that is decoding the stream.
 *
 * So the box takes its final size in a single layout pass and only the paint is
 * animated: a quick fade with a 2px settle, both compositor-only. What is lost
 * is the sense of the body *unfurling*; what is gained is that expanding a card
 * costs exactly one reflow instead of seventeen.
 *
 * Closing is instantaneous by design — there is no `AnimatePresence` here.
 * Keeping the outgoing body mounted through an exit is precisely the height
 * animation this exists to avoid.
 *
 * {@link MotionCollapse} stays as-is for the settings panels, where nothing
 * measures the box and the unfurl is worth having.
 */
export function ReadingCollapse({ open, children, className }: MotionCollapseProps) {
  const { reduce, durationScale } = useFlowMotion()

  if (!open) return null
  if (reduce) return <div className={className}>{children}</div>

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: -2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: MOBILE_DURATION.fast * durationScale, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  )
}

export interface MotionSelectionIndicatorProps {
  /**
   * Shared identity for one selectable group. Every item in the group passes
   * the same value; motion then treats the indicator as *one* element moving
   * rather than one disappearing and another appearing.
   *
   * It must be unique per mounted group. Two workbenches on screen sharing an
   * id would make the indicator fly between them when either one's selection
   * changed, so hosts key it on something instance-scoped.
   */
  groupId: string
  /** Whether this item currently owns the indicator. */
  active: boolean
  /** Shape of the indicator — the caller supplies radius and tint. */
  className?: string
}

/**
 * The moving highlight behind a selected rail button or tab.
 *
 * Selection used to be a per-item background that switched on instantly, so
 * moving between items read as "this one goes out, that one comes on" with
 * nothing connecting them. Rendering a single shared-layout element instead
 * lets motion interpolate its box between the old and new item, which is the
 * one animation that actually communicates *where the selection went*.
 *
 * Sprung rather than timed, per `MOBILE_SPRING`: the travel distance depends on
 * how far apart the two items are, and a fixed duration reads sluggish for
 * neighbours and abrupt for a jump across the rail.
 *
 * The caller positions it — this renders an absolutely-filled layer, so the
 * item needs `relative` and its content needs to sit above it.
 */
export function MotionSelectionIndicator({
  groupId,
  active,
  className,
}: MotionSelectionIndicatorProps) {
  const { reduce } = useFlowMotion()
  if (!active) return null
  // No `layoutId` under reduced motion: that prop is the whole mechanism, so
  // dropping it turns the indicator back into a plain per-item background that
  // appears where it belongs with no travel.
  if (reduce) return <span aria-hidden className={className} />
  return (
    <motion.span aria-hidden layoutId={groupId} className={className} transition={MOBILE_SPRING} />
  )
}

export interface MotionStatusSwapProps {
  /** Changing this key crossfades the old glyph out and the new one in. */
  swapKey: string
  children: ReactNode
  className?: string
}

/**
 * Crossfade a small status glyph when it changes (e.g. running → done). Uses
 * `mode="wait"` so the outgoing glyph fades before the incoming one scales in,
 * avoiding a double-glyph flash. Plain passthrough when motion is reduced.
 */
export function MotionStatusSwap({ swapKey, children, className }: MotionStatusSwapProps) {
  const { reduce, durationScale } = useFlowMotion()

  if (reduce) {
    return <span className={className}>{children}</span>
  }

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={swapKey}
        className={className}
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.6 }}
        transition={{ duration: 0.14 * durationScale, ease: "easeOut" }}
        style={{ display: "inline-flex" }}
      >
        {children}
      </motion.span>
    </AnimatePresence>
  )
}

/**
 * Entry/exit offset for {@link MotionPopover}. Declared as a type alias rather
 * than an interface so it keeps an implicit index signature and stays
 * assignable to motion's `TargetAndTransition`.
 */
export type MotionPopoverOffset = {
  opacity?: number
  scale?: number
  x?: number | string
  y?: number | string
}

export interface MotionPopoverProps {
  /** When true the overlay is shown (and animates in); false animates it out. */
  open: boolean
  children: ReactNode
  className?: string
  /** Positioning styles (left/top/etc.) are forwarded to the animated wrapper. */
  style?: CSSProperties
  /**
   * Where the overlay starts from / exits to. Defaults to a subtle pop
   * (fade + slight scale + small downward nudge). Pass e.g.
   * `{ opacity: 0, x: "100%" }` for a slide-in-from-right rail.
   */
  from?: MotionPopoverOffset
}

/**
 * Enter/exit transition for an explicitly-triggered floating overlay — the
 * terminal command menu, quick-fix, find box, and history rail. Unlike
 * {@link MotionCollapse} (which animates height) this fades + transforms, so a
 * positioned popover pops in place instead of appearing instantly.
 *
 * `AnimatePresence` keeps the outgoing node mounted through its exit, so the
 * parent can toggle `open` while always rendering `<MotionPopover>`. Only
 * `opacity`/`transform` animate (no layout, no backdrop-filter) to stay on the
 * compositor. Collapses to a plain show/hide when motion is reduced (OS hint or
 * user opt-in) and scales duration by `durationScale`.
 *
 * Deliberately NOT used for the high-frequency, follow-the-cursor overlays
 * (ghost text, completion popup, sticky scroll, command decorations): those
 * open/close on every keystroke or scroll frame, where an entrance animation
 * would flicker rather than polish.
 */
export function MotionPopover({ open, children, className, style, from }: MotionPopoverProps) {
  const { reduce, durationScale } = useFlowMotion()

  if (reduce) {
    return open ? (
      <div className={className} style={style}>
        {children}
      </div>
    ) : null
  }

  const offset: MotionPopoverOffset = { opacity: 0, scale: 0.96, y: 4, ...from }

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          key="popover"
          className={className}
          style={style}
          initial={offset}
          animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
          exit={offset}
          transition={{ duration: 0.15 * durationScale, ease: "easeOut" }}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
