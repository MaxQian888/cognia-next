/**
 * Visual language for loop status — same tone mapping as
 * `components/goal/goal-status-style.ts` so the two pills read identically.
 */

import type { LoopStatus } from "@/types/loop"

export type LoopTone = "active" | "paused" | "done" | "halted" | "neutral"

export interface LoopStatusStyle {
  tone: LoopTone
  /** Status dot fill. */
  dot: string
  /** Soft tinted chip background (status badge). */
  chip: string
  /** True for `active` — drives the pulsing dot. */
  pulse: boolean
}

const TONE_BY_STATUS: Record<LoopStatus, LoopTone> = {
  active: "active",
  paused: "paused",
  completed: "done",
  stopped: "neutral",
  iteration_limited: "halted",
  budget_limited: "halted",
  expired: "halted",
  error: "halted",
}

const STYLE_BY_TONE: Record<LoopTone, Omit<LoopStatusStyle, "tone" | "pulse">> = {
  active: { dot: "bg-success", chip: "bg-success/10 text-success" },
  done: { dot: "bg-success", chip: "bg-success/10 text-success" },
  paused: { dot: "bg-warning", chip: "bg-warning/15 text-warning" },
  halted: { dot: "bg-destructive", chip: "bg-destructive/10 text-destructive" },
  neutral: { dot: "bg-muted-foreground", chip: "bg-muted text-muted-foreground" },
}

/** Resolve the visual style for a loop status. */
export function loopStatusStyle(status: LoopStatus): LoopStatusStyle {
  const tone = TONE_BY_STATUS[status] ?? "neutral"
  return { tone, pulse: tone === "active", ...STYLE_BY_TONE[tone] }
}
