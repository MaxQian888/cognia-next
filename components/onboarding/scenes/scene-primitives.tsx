"use client"

/**
 * Shared drawing vocabulary for the first-run narrative scenes.
 *
 * Every scene in this folder is one SVG on a transparent ground, built from
 * the same four parts — a machine frame, a core, chips, and connectors — so
 * that walking the flow reads as one continuous picture rather than four
 * unrelated illustrations. The scan scene's column of chips becomes the
 * express scene's plan, and the core never moves: that continuity is the
 * point, and it only survives if the parts are shared rather than redrawn.
 *
 * **Why hand-drawn SVG rather than bitmaps.** The app is a static export
 * consumed by Tauri and Capacitor, so anything here ships in the bundle and is
 * paid for on the first-run path. Vector geometry costs bytes in the hundreds,
 * adapts to both themes from CSS variables alone, and — the load-bearing
 * reason — can be *driven by real data*. A screenshot cannot light up one node
 * per runtime the probe actually found.
 *
 * **Colour rule.** `--brand-action` is 1.69:1 on a light substrate and
 * `--brand-approval` is 2.15:1 (ADR-0092 V2 §8). They are strokes, fills and
 * state dots here and nothing else; no glyph in this folder carries text, and
 * every state a colour expresses is also expressed by a shape (solid vs dashed
 * outline, dot vs check).
 *
 * ## Why the entrance is CSS and not `motion/react`
 *
 * The first version drove it with `motion.g` and `initial={{ opacity: 0 }}`.
 * That has a failure mode this screen cannot afford: if the animation does not
 * advance — a throttled frame loop, a subtree the compositor has parked, a
 * hidden tab at boot — the element stays at its *initial* value, and the
 * initial value is invisible. A first-run screen that can render blank is not
 * a trade worth making for a nicer easing curve.
 *
 * A CSS `animate-in` degrades the other way. `tw-animate-css` ships
 * `animation-fill-mode: none` by default, so an animation that never runs
 * leaves the element at its own styles, which are the *final* ones. The
 * staggered variants below add `fill-mode-backwards` so the delay still holds
 * the start frame when the animation does run, and drop the whole thing when
 * motion is reduced — a delay is not covered by the `animation-duration: 1ms`
 * guards in `globals.css`, so a reduce-motion user would otherwise stare at a
 * blank panel for the length of the stagger.
 *
 * `useFlowMotion()` stays because it is the app's single reduced-motion
 * verdict: the OS hint, the appearance setting, and the speed multiplier, all
 * folded together. `useReducedMotion()` alone would see only the first.
 */

import type { CSSProperties, ReactNode } from "react"

import { cn } from "@/lib/utils"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"

/**
 * One coordinate system for every scene, so the core lands on the same pixel
 * as the user moves between steps and the eye can follow it.
 */
export const SCENE_WIDTH = 320
export const SCENE_HEIGHT = 240
export const SCENE_VIEWBOX = `0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`

/** Hairline weight. Everything structural is drawn at this; nothing is heavier. */
export const HAIRLINE = 1.25

/** Base entrance duration in ms, before the user's speed multiplier. */
const ENTER_MS = 420

/** How long a connector takes to draw itself in. */
const DRAW_MS = 620

/** Gap between staggered parts, and the cap on how far the stagger runs. */
const STAGGER_MS = 55
const MAX_STAGGER_STEPS = 8

/**
 * The four states any node in a scene can be in.
 *
 *  - `idle`    — not going to happen. Dropped from the plan, or a slot the
 *                probe never filled.
 *  - `ready`   — armed: selected and waiting for the button. Neutral outline
 *                with a brand mark, because "will run" and "has run" must not
 *                look alike on a screen whose whole promise is that nothing
 *                has happened yet.
 *  - `pending` — in flight, or found-but-unauthenticated.
 *  - `active`  — done, or signed in.
 */
export type SceneTone = "idle" | "ready" | "pending" | "active"

/** Outline colour per tone. Shape carries the state too — see the colour rule. */
export const TONE_STROKE: Record<SceneTone, string> = {
  idle: "var(--color-border)",
  ready: "var(--color-border)",
  pending: "var(--color-brand-approval)",
  active: "var(--color-brand-action)",
}

/**
 * Colour of the state dot. Split from the outline so `ready` can carry a brand
 * mark on a neutral frame — the frame says "this is a line", the mark says
 * "this one is going to run".
 */
export const TONE_MARK: Record<SceneTone, string> = {
  idle: "var(--color-border)",
  ready: "var(--color-brand-action)",
  pending: "var(--color-brand-approval)",
  active: "var(--color-brand-action)",
}

export interface EntranceProps {
  className?: string
  style?: CSSProperties
}

/**
 * Entrance props for a part at `index` in a staggered group.
 *
 * Returns an empty object when motion is reduced, so the caller can spread it
 * and get a plain element at its final values.
 */
export function useSceneEntrance() {
  const { reduce, durationScale } = useFlowMotion()

  const delayMs = (index: number) =>
    Math.round(Math.min(index, MAX_STAGGER_STEPS) * STAGGER_MS * durationScale)

  const entrance = (index = 0, variant: "pop" | "fade" = "pop"): EntranceProps => {
    if (reduce) return {}
    return {
      className: cn("animate-in fade-in fill-mode-backwards", variant === "pop" && "zoom-in-95"),
      style: {
        animationDuration: `${Math.round(ENTER_MS * durationScale)}ms`,
        animationDelay: `${delayMs(index)}ms`,
      },
    }
  }

  return {
    reduce,
    /** A part that scales and fades in. */
    enter: (index = 0) => entrance(index, "pop"),
    /**
     * A connector that draws itself from the chip to the core.
     *
     * Requires `pathLength={1}` on the path — see the keyframe in
     * `globals.css`. A dashed connector cannot draw (the dash pattern and the
     * draw pattern are the same property), so those get the flowing variant
     * from {@link flow} instead, which says something better anyway.
     */
    draw: (index = 0): EntranceProps => {
      if (reduce) return {}
      return {
        className: "onboarding-draw",
        style: {
          animationDuration: `${Math.round(DRAW_MS * durationScale)}ms`,
          animationDelay: `${delayMs(index + 2)}ms`,
        },
      }
    },
    /** Marching ants, for a connector whose work is still in flight. */
    flow: (): EntranceProps => (reduce ? {} : { className: "onboarding-flow" }),
  }
}

interface SceneCanvasProps {
  children: ReactNode
  className?: string
  /**
   * Announced to assistive tech in place of the geometry. Scenes are
   * decorative *restatements* of what the step body already says in text, so
   * this is a short label rather than a description of every node.
   */
  label: string
  "data-testid"?: string
}

/**
 * The SVG frame every scene renders into.
 *
 * `overflow-visible` because the core's halo is drawn outside the viewBox
 * bounds on purpose — clipping it produces a hard square edge on a soft glow.
 */
export function SceneCanvas({
  children,
  className,
  label,
  "data-testid": testId,
}: SceneCanvasProps) {
  return (
    <svg
      viewBox={SCENE_VIEWBOX}
      role="img"
      aria-label={label}
      data-testid={testId}
      className={cn("h-auto w-full overflow-visible", className)}
    >
      {children}
    </svg>
  )
}

/**
 * The machine: the outer frame the whole flow happens inside.
 *
 * Present in every scene at the same coordinates. It is what makes the flow
 * read as "an agent in *your* desktop" rather than a sequence of abstract
 * diagrams — and it is why the chips sit inside it rather than orbiting a logo.
 */
export function MachineFrame({ children }: { children?: ReactNode }) {
  const { enter } = useSceneEntrance()
  return (
    <g {...enter(0)} data-testid="scene-machine">
      <rect
        x={20}
        y={28}
        width={280}
        height={184}
        rx={14}
        fill="var(--color-background)"
        stroke="var(--color-border)"
        strokeWidth={HAIRLINE}
      />
      {/* Title bar: a hairline and three dots. Enough to read as a window
          without drawing a window nobody is meant to look at. */}
      <line x1={20} y1={52} x2={300} y2={52} stroke="var(--color-border)" strokeWidth={HAIRLINE} />
      {[36, 46, 56].map((cx) => (
        <circle key={cx} cx={cx} cy={40} r={2.5} fill="var(--color-border)" />
      ))}
      {children}
    </g>
  )
}

/** Where the core sits, in every scene. Exported so connectors can aim at it. */
export const CORE = { x: 232, y: 128, size: 44 } as const

interface CoreNodeProps {
  /** Draws the halo. False until the flow has something real to show. */
  active?: boolean
  /** Stagger position within the scene's entrance. */
  index?: number
}

/**
 * Cognia itself — the thing everything else connects to.
 *
 * Its glyph is a three-bar stack rather than a logo: at 44px a wordmark is
 * illegible, and the stack says "a working set" in a way that stays true on
 * every step. The top bar carries the brand hue so the core reads as live
 * without tinting the whole shape.
 */
export function CoreNode({ active = false, index = 1 }: CoreNodeProps) {
  const { enter, reduce } = useSceneEntrance()
  const half = CORE.size / 2
  const haloR = CORE.size * 0.86
  return (
    <g {...enter(index)} data-testid="scene-core" data-active={active}>
      {active && (
        // One slow breath rather than a still halo. The user can sit on this
        // screen for the length of an OAuth round trip, and a scene that is
        // completely frozen during it reads as a hung render.
        <circle
          cx={CORE.x}
          cy={CORE.y}
          r={haloR}
          fill="var(--color-brand-action)"
          opacity={0.1}
          className={reduce ? undefined : "onboarding-breathe"}
          style={{ ["--onboarding-halo-r" as string]: haloR }}
          data-testid="scene-core-halo"
        />
      )}
      <rect
        x={CORE.x - half}
        y={CORE.y - half}
        width={CORE.size}
        height={CORE.size}
        rx={12}
        fill="var(--color-brand-wash)"
        stroke={active ? "var(--color-brand-action)" : "var(--color-border)"}
        strokeWidth={HAIRLINE}
      />
      {[0, 1, 2].map((row) => (
        <rect
          key={row}
          x={CORE.x - 11}
          y={CORE.y - 8 + row * 8}
          width={row === 0 ? 22 : row === 1 ? 16 : 11}
          height={3}
          rx={1.5}
          fill={row === 0 && active ? "var(--color-brand-action)" : "var(--color-muted-foreground)"}
          opacity={row === 0 ? 1 : 0.45}
        />
      ))}
    </g>
  )
}

/** Geometry of one chip in the left-hand column. */
export const CHIP = { x: 44, width: 108, height: 26, gap: 10 } as const

/** Vertical centre of the chip at `index`, for a column of `total`. */
export function chipCenterY(index: number, total: number): number {
  const span = total * CHIP.height + (total - 1) * CHIP.gap
  const top = CORE.y - span / 2
  return top + index * (CHIP.height + CHIP.gap) + CHIP.height / 2
}

interface SlotChipProps {
  index: number
  total: number
  tone: SceneTone
  /** Solid when settled, dashed while the slot is still hypothetical. */
  dashed?: boolean
  /** A check tick instead of the state dot — "this one is done". */
  done?: boolean
  /** Bars standing in for the label. Real text lives in the step body. */
  fill?: number
  /**
   * Stagger position, when it should differ from the row. A chip that is
   * *reacting* to something (a plan line that just finished) passes `0`, so it
   * pops immediately rather than waiting out a stagger meant for the initial
   * paint.
   */
  entranceIndex?: number
  "data-testid"?: string
}

/**
 * One item in the left column: a discovered runtime, or a plan line.
 *
 * The scan and express scenes deliberately share it. What the scan finds is
 * literally what the express plan proposes to do, and drawing them with the
 * same part is how the picture says so.
 */
export function SlotChip({
  index,
  total,
  tone,
  dashed = false,
  done = false,
  fill = 1,
  entranceIndex,
  "data-testid": testId,
}: SlotChipProps) {
  const { enter } = useSceneEntrance()
  const cy = chipCenterY(index, total)
  const stroke = TONE_STROKE[tone]
  const mark = TONE_MARK[tone]
  return (
    <g {...enter(entranceIndex ?? index + 2)} data-testid={testId} data-tone={tone}>
      <rect
        x={CHIP.x}
        y={cy - CHIP.height / 2}
        width={CHIP.width}
        height={CHIP.height}
        rx={8}
        fill={tone === "idle" ? "transparent" : "var(--color-brand-wash)"}
        stroke={stroke}
        strokeWidth={HAIRLINE}
        strokeDasharray={dashed ? "4 4" : undefined}
        opacity={tone === "idle" ? 0.55 : 1}
      />
      {done ? (
        <path
          d={`M${CHIP.x + 10} ${cy} l3.5 3.5 l6.5 -7`}
          fill="none"
          stroke="var(--color-brand-action)"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : (
        <circle
          cx={CHIP.x + 14}
          cy={cy}
          r={4}
          // Hollow while armed, filled once it means something has happened.
          fill={tone === "idle" || tone === "ready" ? "none" : mark}
          stroke={mark}
          strokeWidth={HAIRLINE}
        />
      )}
      {/* Two label bars. Their width is the only thing that varies between
          chips, which keeps a column of five from looking rubber-stamped. */}
      <rect
        x={CHIP.x + 26}
        y={cy - 5}
        width={Math.round(46 * fill)}
        height={3.5}
        rx={1.75}
        fill="var(--color-muted-foreground)"
        opacity={tone === "idle" ? 0.3 : 0.7}
      />
      <rect
        x={CHIP.x + 26}
        y={cy + 2}
        width={Math.round(30 * fill)}
        height={3.5}
        rx={1.75}
        fill="var(--color-muted-foreground)"
        opacity={tone === "idle" ? 0.2 : 0.4}
      />
    </g>
  )
}

interface ConnectorProps {
  index: number
  total: number
  tone: Exclude<SceneTone, "idle" | "ready">
  dashed?: boolean
  "data-testid"?: string
}

/**
 * The line from a chip into the core.
 *
 * Drawn as a cubic with both control points horizontal, so lines from very
 * different heights all arrive at the core flat — a fan of straight diagonals
 * reads as a chart, and this is not one.
 */
export function Connector({
  index,
  total,
  tone,
  dashed = false,
  "data-testid": testId,
}: ConnectorProps) {
  const { draw, flow } = useSceneEntrance()
  const cy = chipCenterY(index, total)
  const x1 = CHIP.x + CHIP.width
  const x2 = CORE.x - CORE.size / 2
  const mid = x1 + (x2 - x1) / 2
  // A dashed line cannot also draw itself on — both want `stroke-dasharray` —
  // so the two states get the motion that suits them: a settled connector
  // draws once, an in-flight one keeps flowing until it settles.
  const motion = dashed ? flow() : draw(index)
  return (
    <path
      {...motion}
      // Normalises every curve to a unit length, so one keyframe serves
      // connectors of wildly different geometry. See `onboarding-draw`.
      pathLength={dashed ? undefined : 1}
      d={`M${x1} ${cy} C${mid} ${cy} ${mid} ${CORE.y} ${x2} ${CORE.y}`}
      fill="none"
      stroke={TONE_STROKE[tone]}
      strokeWidth={HAIRLINE}
      strokeLinecap="round"
      strokeDasharray={dashed ? "3 5" : undefined}
      opacity={0.85}
      data-testid={testId}
      data-tone={tone}
    />
  )
}

/**
 * A small counted badge under the core — "128", "999+".
 *
 * The number is the one piece of real text any scene carries, because a count
 * drawn as bars is a count the user has to take on faith.
 */
export function CountBadge({
  value,
  y = CORE.y + CORE.size / 2 + 22,
  "data-testid": testId,
}: {
  value: string
  y?: number
  "data-testid"?: string
}) {
  const { enter } = useSceneEntrance()
  return (
    // Keyed on the value so a count that moves — the history walk finding more
    // sources — pops rather than silently swapping digits.
    <g key={value} {...enter(4)} data-testid={testId}>
      <rect
        x={CORE.x - 30}
        y={y - 11}
        width={60}
        height={22}
        rx={11}
        fill="var(--color-brand-wash)"
        stroke="var(--color-border)"
        strokeWidth={HAIRLINE}
      />
      <text
        x={CORE.x}
        y={y + 4}
        textAnchor="middle"
        className="fill-muted-foreground text-[11px] font-medium"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {value}
      </text>
    </g>
  )
}
