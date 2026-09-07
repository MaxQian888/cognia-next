/**
 * Who gets to keep the screen on, and what "let it go dark" actually costs.
 *
 * A long turn used to force a choice nobody should have to make: sit and touch
 * the trackpad, or walk away and find out later whether anything survived. The
 * answer differs per conversation. A 40-minute refactor wants the machine left
 * alone, a demo running on a projector wants the panel lit. So the policy is a
 * per-conversation override with an app-wide default underneath it.
 *
 * Pure: no React, no Dexie, no `window`. The coordinator
 * (`hooks/power/use-session-power-guard.ts`) feeds it the running sessions and
 * hands the result to `lib/power/screen-wake-lock.ts`, which is the only module
 * that touches a platform lock.
 */

import type {
  AppSettings,
  ChatSession,
  SessionPowerMode,
  SessionPowerPolicy,
} from "@cognia/agent-config-types"
import type { HostProfile } from "@/lib/platform/capabilities"

/** Selectable modes, in the order the UI lists them. */
export const SESSION_POWER_MODES: readonly SessionPowerMode[] = ["allowScreenOff", "keepScreenOn"]

/** Per-conversation choices: the modes plus "follow the app default". */
export const SESSION_POWER_POLICIES: readonly SessionPowerPolicy[] = [
  "inherit",
  ...SESSION_POWER_MODES,
]

/**
 * What the app does when nothing is configured: nothing extra. The desktop host
 * already refuses to idle-sleep while a run is in flight
 * (`src-tauri/src/power_assertion.rs`), so the shipped behaviour is exactly
 * "the turn keeps going, the screen may go dark". This default preserves it
 * rather than quietly lighting up every user's display.
 */
export const DEFAULT_SESSION_POWER_MODE: SessionPowerMode = "allowScreenOff"

/** Narrowing guard for values coming back off a persisted row. */
export function isSessionPowerMode(value: unknown): value is SessionPowerMode {
  return typeof value === "string" && (SESSION_POWER_MODES as readonly string[]).includes(value)
}

/** The app-wide default, with the legacy (absent) value resolved. */
export function resolveDefaultPowerMode(
  settings: Pick<AppSettings, "sessionPowerPolicy"> | null | undefined
): SessionPowerMode {
  return isSessionPowerMode(settings?.sessionPowerPolicy)
    ? settings.sessionPowerPolicy
    : DEFAULT_SESSION_POWER_MODE
}

/**
 * One conversation's effective mode. `inherit`, and any legacy row with no
 * column at all, falls through to the app default.
 */
export function resolveSessionPowerMode(
  policy: SessionPowerPolicy | undefined,
  appDefault: SessionPowerMode
): SessionPowerMode {
  return isSessionPowerMode(policy) ? policy : appDefault
}

export interface ScreenHoldInput {
  /** Sessions with a turn in flight right now. */
  runningSessionIds: readonly string[]
  /** Rows for (at least) those sessions. Missing rows resolve to the default. */
  sessions: readonly Pick<ChatSession, "id" | "powerPolicy">[]
  appDefault: SessionPowerMode
}

/**
 * Which conversations are asking for the screen right now, sorted, so an
 * unchanged answer is a stable array the coordinator can compare cheaply.
 *
 * A session that is NOT running never appears here even with the policy on.
 * The promise is "while this conversation runs", and a policy that held the
 * display for an idle chat would be a battery bug wearing a feature's clothes.
 */
export function sessionsHoldingScreen(input: ScreenHoldInput): string[] {
  const policyById = new Map(input.sessions.map((row) => [row.id, row.powerPolicy]))
  return [...new Set(input.runningSessionIds)]
    .filter(
      (id) => resolveSessionPowerMode(policyById.get(id), input.appDefault) === "keepScreenOn"
    )
    .sort()
}

/**
 * What the chosen mode actually buys on THIS host, which is the line the
 * settings UI prints under the control.
 *
 * - `screenHeld`: the display is held for the length of the turn.
 * - `screenHoldUnavailable`: asked for, but this runtime exposes no lock.
 * - `runsOnHost`: the screen may go dark, and execution lives in another
 *   process (the desktop sidecar, or a paired host) that carries on regardless.
 * - `mayPauseWhenHidden`: the honest answer for a lone browser tab. The turn
 *   runs in this page, so a backgrounded tab can be throttled or discarded.
 */
export const SESSION_POWER_EFFECTS = [
  "screenHeld",
  "screenHoldUnavailable",
  "runsOnHost",
  "mayPauseWhenHidden",
] as const

export type SessionPowerEffect = (typeof SESSION_POWER_EFFECTS)[number]

export function describeSessionPowerEffect(
  mode: SessionPowerMode,
  profile: HostProfile,
  screenHoldAvailable = true
): SessionPowerEffect {
  if (mode === "keepScreenOn") {
    return screenHoldAvailable ? "screenHeld" : "screenHoldUnavailable"
  }
  // `web-standalone` is the one profile with no execution plane but this page.
  return profile === "web-standalone" ? "mayPauseWhenHidden" : "runsOnHost"
}
