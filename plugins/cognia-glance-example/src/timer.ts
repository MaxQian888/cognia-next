/**
 * The focus timer behind the example glance module: pure state transitions
 * and the module data built from them, so the plugin entry only wires the
 * host APIs and every rule here is testable without a host.
 *
 * A focus session runs for `FOCUS_MS`. It can be paused and resumed, and it
 * counts as done once its end time has passed. Completion is settled lazily
 * (on the next read), from the end time itself, so a session that ended while
 * the app was closed or the module was hidden still lands on the right day.
 */

import type { PluginGlanceModuleData } from "@cognia/plugin-sdk"

/** One focus session. */
export const FOCUS_MS = 25 * 60_000

/** The manifest command ids the module's buttons run (`<pluginId>.<id>`). */
export const TOGGLE_COMMAND = "focus-toggle"
export const RESET_COMMAND = "focus-reset"

export type FocusPhase = "idle" | "running" | "paused"

export interface FocusState {
  phase: FocusPhase
  /** When a running session ends; null otherwise. */
  endsAt: number | null
  /** What is left of a paused session, or a full session when idle. */
  remainingMs: number
  /** Local day (`YYYY-MM-DD`) `completedToday` counts. */
  day: string
  completedToday: number
}

/** The local calendar day of an instant. */
export function localDay(at: number): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

export function initialState(now: number): FocusState {
  return {
    phase: "idle",
    endsAt: null,
    remainingMs: FOCUS_MS,
    day: localDay(now),
    completedToday: 0,
  }
}

/**
 * A stored state, checked: anything that is not one becomes a fresh idle
 * state, so a corrupted or older blob never breaks the module.
 */
export function restoreState(raw: unknown, now: number): FocusState {
  if (typeof raw !== "object" || raw === null) return initialState(now)
  const value = raw as Record<string, unknown>
  const phase = value.phase
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)
  if (phase !== "idle" && phase !== "running" && phase !== "paused") return initialState(now)
  if (!finite(value.remainingMs) || value.remainingMs <= 0 || value.remainingMs > FOCUS_MS) {
    return initialState(now)
  }
  if (phase === "running" && !finite(value.endsAt)) return initialState(now)
  if (typeof value.day !== "string" || !finite(value.completedToday) || value.completedToday < 0) {
    return initialState(now)
  }
  return {
    phase,
    endsAt: phase === "running" ? (value.endsAt as number) : null,
    remainingMs: value.remainingMs,
    day: value.day,
    completedToday: Math.floor(value.completedToday),
  }
}

/** Finish a session whose end has passed, and start a new day's count. */
export function settle(state: FocusState, now: number): FocusState {
  let next = state
  if (next.phase === "running" && next.endsAt !== null && now >= next.endsAt) {
    const doneDay = localDay(next.endsAt)
    next = {
      phase: "idle",
      endsAt: null,
      remainingMs: FOCUS_MS,
      day: doneDay,
      completedToday: (doneDay === next.day ? next.completedToday : 0) + 1,
    }
  }
  const today = localDay(now)
  if (next.day !== today) next = { ...next, day: today, completedToday: 0 }
  return next
}

/** Start, pause or resume. */
export function toggle(state: FocusState, now: number): FocusState {
  const current = settle(state, now)
  switch (current.phase) {
    case "idle":
      return { ...current, phase: "running", endsAt: now + FOCUS_MS, remainingMs: FOCUS_MS }
    case "running":
      return {
        ...current,
        phase: "paused",
        endsAt: null,
        remainingMs: Math.max(1, (current.endsAt ?? now) - now),
      }
    case "paused":
      return { ...current, phase: "running", endsAt: now + current.remainingMs }
  }
}

/** Abandon the current session; today's count stays. */
export function reset(state: FocusState, now: number): FocusState {
  const current = settle(state, now)
  return { ...current, phase: "idle", endsAt: null, remainingMs: FOCUS_MS }
}

/** What is left of the session at `now`. */
export function remainingAt(state: FocusState, now: number): number {
  if (state.phase === "running" && state.endsAt !== null) return Math.max(0, state.endsAt - now)
  return state.remainingMs
}

/** Whole minutes left, rounded up so the last seconds read "1", not "0". */
export function minutesLeft(state: FocusState, now: number): number {
  return Math.ceil(remainingAt(state, now) / 60_000)
}

/** Resolves a manifest i18n key with `{name}` parameters. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** The module data for a settled state. */
export function buildModuleData(
  state: FocusState,
  now: number,
  t: Translate
): PluginGlanceModuleData {
  const minutes = minutesLeft(state, now)
  const summary =
    state.phase === "running"
      ? t("summary.running", { minutes })
      : state.phase === "paused"
        ? t("summary.paused", { minutes })
        : t("summary.idle", { count: state.completedToday })
  const toggleLabel =
    state.phase === "running"
      ? t("action.pause")
      : state.phase === "paused"
        ? t("action.resume")
        : t("action.start")
  return {
    summary,
    stats: [
      {
        label: t("stat.left"),
        value: t("stat.minutes", { minutes }),
        tone: state.phase === "running" ? "ok" : state.phase === "paused" ? "warn" : "muted",
      },
      { label: t("stat.done"), value: String(state.completedToday) },
    ],
    actions: [
      {
        id: "toggle",
        label: toggleLabel,
        icon: state.phase === "running" ? "Pause" : "Play",
        command: TOGGLE_COMMAND,
      },
      ...(state.phase === "idle"
        ? []
        : [
            {
              id: "reset",
              label: t("action.reset"),
              icon: "RotateCcw" as const,
              command: RESET_COMMAND,
            },
          ]),
    ],
  }
}
