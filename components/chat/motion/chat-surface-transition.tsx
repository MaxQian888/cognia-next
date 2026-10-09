"use client"

/**
 * `ChatSurfaceTransition` — the motion between what a chat pane shows.
 *
 * A pane has three top-level surfaces: the home welcome (no session bound),
 * a conversation, and the runtime notice that stands in for either while the
 * runtime is unavailable. Moving between them used to be a hard cut: the
 * hero, its composer and every card vanished in one frame and the
 * conversation's header, banners and transcript appeared in the next. Switching
 * from one conversation to another was a cut too, with nothing to tell the eye
 * the content underneath had changed.
 *
 * Surfaces are ordered by depth (home and notice at the top, a conversation one
 * level in), and the motion says which way the user went:
 *
 *   - into a conversation, the welcome recedes (drifts up, shrinks a touch,
 *     fades) while the conversation rises in from just below;
 *   - back home, the conversation sinks away and the welcome settles back in
 *     from a hair larger, like a layer being lifted off;
 *   - between surfaces of the same depth, a plain soft crossfade.
 *
 * The swap is a crossfade in place: `popLayout` lifts the exiting surface out
 * of the column (pinned against this component's `relative` stage) so the
 * entering one owns the full height from its first frame, the same technique
 * the pane's inner welcome ⇄ transcript swap uses. A conversation-to-
 * conversation switch is not a surface change — the conversation surface is
 * kept, so the transcript, composer and their state are not torn down — and
 * gets a short settle on the stage instead (a brief dip and rise), enough to
 * mark the change without replaying an entrance.
 *
 * Everything is `opacity` + `transform` only: the transcript inside is watched
 * by `ResizeObserver`s (ADR-0138), and a transform never re-lays it out.
 * Durations ride the shared motion tokens and the user's speed preference;
 * with reduced motion the swap is instant and the settle is skipped.
 */

import { animate, AnimatePresence, motion, type Variants } from "motion/react"
import { useEffect, useRef, useState, type ReactNode } from "react"

import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"

export type ChatSurface = "home" | "notice" | "conversation"

/** How far in a surface sits; motion direction is the sign of the change. */
const SURFACE_DEPTH: Record<ChatSurface, number> = {
  home: 0,
  notice: 0,
  conversation: 1,
}

/** -1 back out, 0 sideways, 1 deeper in. */
export type ChatSurfaceDirection = -1 | 0 | 1

export function chatSurfaceDirection(from: ChatSurface, to: ChatSurface): ChatSurfaceDirection {
  return Math.sign(SURFACE_DEPTH[to] - SURFACE_DEPTH[from]) as ChatSurfaceDirection
}

/** Where a surface starts from when it enters by `direction`. */
function enterFrom(direction: ChatSurfaceDirection) {
  if (direction > 0) return { opacity: 0, y: 18, scale: 0.985 }
  if (direction < 0) return { opacity: 0, y: -12, scale: 1.015 }
  return { opacity: 0, y: 6, scale: 1 }
}

/** Where a surface goes when it leaves by `direction`. */
function exitTo(direction: ChatSurfaceDirection) {
  if (direction > 0) return { opacity: 0, y: -10, scale: 0.98 }
  if (direction < 0) return { opacity: 0, y: 16, scale: 0.99 }
  return { opacity: 0, y: 0, scale: 1 }
}

/** What `AnimatePresence` hands an exiting surface. */
export interface ChatSurfaceExit {
  direction: ChatSurfaceDirection
  durationScale: number
}

/**
 * The surface choreography for a surface entering by `direction`. The exit is
 * a function of the presence's `custom` rather than of these arguments: an
 * exiting surface keeps the props it last rendered with, so only the value
 * `AnimatePresence` passes at removal time knows the move that removed it.
 * (`custom` is deliberately not set on the layer itself — motion would
 * forward it to the DOM wherever a permissive prop validator is loaded.)
 */
export function chatSurfaceVariants(
  direction: ChatSurfaceDirection,
  durationScale: number
): Variants {
  return {
    enter: enterFrom(direction),
    center: {
      opacity: 1,
      y: 0,
      scale: 1,
      transition: { duration: MOBILE_DURATION.normal * durationScale, ease: MOBILE_EASE },
    },
    exit: (exit: ChatSurfaceExit | undefined) => ({
      ...exitTo(exit?.direction ?? 0),
      transition: {
        duration: MOBILE_DURATION.fast * (exit?.durationScale ?? durationScale),
        ease: MOBILE_EASE,
      },
    }),
  }
}

/** The conversation-to-conversation settle: a quick dip and rise on the stage. */
export const CHAT_SESSION_SETTLE = {
  keyframes: { opacity: [0.4, 1], y: [6, 0] },
  duration: 0.24,
} as const

export interface ChatSurfaceTransitionProps {
  surface: ChatSurface
  /** The conversation on screen; a change within `conversation` plays the settle. */
  sessionId: string | null
  /** Called once an exiting surface has finished leaving. */
  onExitComplete?: () => void
  children: ReactNode
}

export function ChatSurfaceTransition({
  surface,
  sessionId,
  onExitComplete,
  children,
}: ChatSurfaceTransitionProps) {
  const { reduce, durationScale } = useFlowMotion()
  const stageRef = useRef<HTMLDivElement>(null)

  // The direction of the last surface change, derived while rendering (the
  // documented "adjust state when a prop changes" pattern) so the entering and
  // exiting surfaces read it in the same commit that swaps them.
  const [trail, setTrail] = useState<{ surface: ChatSurface; direction: ChatSurfaceDirection }>(
    () => ({ surface, direction: 0 })
  )
  if (trail.surface !== surface) {
    setTrail({ surface, direction: chatSurfaceDirection(trail.surface, surface) })
  }

  // Settle on a conversation switch. Only when the conversation surface stays
  // up — a surface change already has its own entrance — and never for the
  // first conversation the stage shows.
  const shown = useRef<{ surface: ChatSurface; sessionId: string | null }>({ surface, sessionId })
  useEffect(() => {
    const previous = shown.current
    shown.current = { surface, sessionId }
    const stage = stageRef.current
    if (
      !stage ||
      reduce ||
      surface !== "conversation" ||
      previous.surface !== "conversation" ||
      previous.sessionId === sessionId
    ) {
      return
    }
    const controls = animate(stage, CHAT_SESSION_SETTLE.keyframes, {
      duration: CHAT_SESSION_SETTLE.duration * durationScale,
      ease: MOBILE_EASE,
    })
    return () => controls.stop()
  }, [surface, sessionId, reduce, durationScale])

  const exit: ChatSurfaceExit = { direction: trail.direction, durationScale }

  return (
    <div
      ref={stageRef}
      data-slot="chat-surface"
      data-surface={surface}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <AnimatePresence
        mode="popLayout"
        initial={false}
        custom={exit}
        onExitComplete={onExitComplete}
      >
        <motion.div
          key={surface}
          data-slot="chat-surface-layer"
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          variants={reduce ? undefined : chatSurfaceVariants(trail.direction, durationScale)}
          initial={reduce ? false : "enter"}
          animate="center"
          exit={reduce ? undefined : "exit"}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}
