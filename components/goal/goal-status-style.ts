/**
 * Shared visual language for goal status (ADR-0019 Phase 3 polish). One
 * source of truth for the semantic tone + Tailwind classes so the console
 * card, the composer pill, and the overview tab all read identically.
 *
 * Tones map onto Cognia's existing semantic tokens (`success` / `warning` /
 * `destructive` / muted) — no new colors introduced.
 */

import type { GoalStatus } from "@/types/goal"

export type GoalTone = "active" | "paused" | "done" | "halted" | "neutral"

export interface GoalStatusStyle {
  tone: GoalTone
  /** Left accent rail on cards. */
  rail: string
  /** Status dot fill. */
  dot: string
  /** Status label text color. */
  text: string
  /** Soft tinted chip background (status badge). */
  chip: string
  /** Progress-bar fill tint. */
  bar: string
  /** True for `active` — drives the pulsing dot. */
  pulse: boolean
}

const TONE_BY_STATUS: Record<GoalStatus, GoalTone> = {
  active: "active",
  paused: "paused",
  completed: "done",
  stopped: "neutral",
  budget_limited: "halted",
  turn_limited: "halted",
  timed_out: "halted",
  preempted: "neutral",
}

const STYLE_BY_TONE: Record<GoalTone, Omit<GoalStatusStyle, "tone" | "pulse">> = {
  active: {
    rail: "bg-success",
    dot: "bg-success",
    text: "text-success",
    chip: "bg-success/10 text-success",
    bar: "bg-success",
  },
  done: {
    rail: "bg-success",
    dot: "bg-success",
    text: "text-success",
    chip: "bg-success/10 text-success",
    bar: "bg-success",
  },
  paused: {
    rail: "bg-warning",
    dot: "bg-warning",
    text: "text-warning",
    chip: "bg-warning/15 text-warning",
    bar: "bg-warning",
  },
  halted: {
    rail: "bg-destructive",
    dot: "bg-destructive",
    text: "text-destructive",
    chip: "bg-destructive/10 text-destructive",
    bar: "bg-destructive",
  },
  neutral: {
    rail: "bg-muted-foreground/40",
    dot: "bg-muted-foreground",
    text: "text-muted-foreground",
    chip: "bg-muted text-muted-foreground",
    bar: "bg-muted-foreground",
  },
}

/** Resolve the visual style for a goal status. */
export function goalStatusStyle(status: GoalStatus): GoalStatusStyle {
  const tone = TONE_BY_STATUS[status] ?? "neutral"
  return { tone, pulse: tone === "active", ...STYLE_BY_TONE[tone] }
}

/**
 * Chart fill for a status: the status's own tone (as a CSS variable, so it
 * follows the theme) at an opacity that tells apart statuses sharing a tone —
 * `active` from `completed`, the three limit exits from each other. The
 * analytics donut used to colour slices from a generic palette by position, so
 * "completed" could be orange in the chart and green everywhere else.
 */
export interface GoalStatusChartColor {
  fill: string
  opacity: number
}

const TONE_VAR: Record<GoalTone, string> = {
  active: "var(--success)",
  done: "var(--success)",
  paused: "var(--warning)",
  halted: "var(--destructive)",
  neutral: "var(--muted-foreground)",
}

const STATUS_OPACITY: Record<GoalStatus, number> = {
  active: 1,
  completed: 0.55,
  paused: 1,
  budget_limited: 1,
  turn_limited: 0.7,
  timed_out: 0.45,
  stopped: 0.8,
  preempted: 0.45,
}

export function goalStatusChartColor(status: GoalStatus): GoalStatusChartColor {
  const tone = TONE_BY_STATUS[status] ?? "neutral"
  return { fill: TONE_VAR[tone], opacity: STATUS_OPACITY[status] ?? 1 }
}
