/**
 * Where should this diagnostic appear?
 *
 * One pure function, no React and no Dexie, so the whole decision matrix is
 * unit-testable and there is exactly one place to argue with about it.
 *
 * The rules encode four things the app used to get wrong:
 *
 *  1. **A failure the user is already looking at does not also need a toast.**
 *     The chat pane rendered an inline error card *and* the desktop workspace
 *     fired a sonner toast for the same failure, so a single 429 announced
 *     itself twice.
 *  2. **A burst is one incident.** A sidecar crash fails every in-flight
 *     session at once; surfacing each separately turns one event into a wall.
 *  3. **A steady state is not an event.** "Sidecar not running" stays true
 *     until someone restarts it — putting it on a badge and re-toasting it on
 *     every retry tick are very different experiences.
 *  4. **A failure the user cannot see did not happen.** Anything that lands
 *     while they are elsewhere belongs in the notification center, which is
 *     durable and already handles DND, dedupe and OS fan-out.
 */

import type { CogniaDiagnostic } from "@cognia/diagnostics"

import { CASCADE_THRESHOLD } from "./cascade"

/** Where the diagnostic was produced, relative to what the user is doing. */
export interface DiagnosticOrigin {
  kind:
    | "chat"
    | "agent-team"
    | "settings"
    | "workflow-editor"
    | "external-agent-manager"
    | "inbox"
    | "background"
  /** Session / run / adapter id, for dedupe scoping. */
  id?: string
}

export interface SurfaceContext {
  origin: DiagnosticOrigin
  /** The origin surface is mounted, visible, and the window has focus. */
  watching: boolean
  /** The origin surface mounted a slot that can render an inline card. */
  hasInlineHost: boolean
  /** How many diagnostics landed in the cascade window, including this one. */
  recentCount: number
  /** Set for failures that happen before the app is usable (boot). */
  bootScope?: boolean
}

export type DiagnosticSurface = "modal" | "inline" | "toast" | "badge" | "center"

export interface SurfaceDecision {
  surface: DiagnosticSurface
  /**
   * Also pin a banner. Only when the condition blocks the surface's main
   * action — a badge alone is easy to miss, a banner on every degradation is
   * the noise these rules exist to prevent.
   */
  banner?: boolean
  /** Fold into a single aggregate notice rather than announcing individually. */
  collapsed?: boolean
}

/**
 * Stable key for coalescing repeats of the same condition.
 *
 * `notify()` already merges on this and bumps a count, so a flapping adapter
 * produces one row that counts up rather than fifty rows.
 */
export function diagnosticDedupeKey(diag: CogniaDiagnostic, origin?: DiagnosticOrigin): string {
  const scope =
    diag.meta?.agentId ??
    diag.meta?.adapterId ??
    diag.meta?.sessionId ??
    diag.meta?.runId ??
    origin?.id ??
    "global"
  return `${diag.code}:${scope}`
}

export function resolveSurface(diag: CogniaDiagnostic, ctx: SurfaceContext): SurfaceDecision {
  // 1 — the app cannot continue. Never a toast: there is nothing to go back to.
  if (diag.severity === "fatal" && ctx.bootScope) {
    return { surface: "modal" }
  }

  // 2 — a burst is one incident. Checked before the inline rule so a storm
  // cannot fill the pane with cards either.
  if (ctx.recentCount >= CASCADE_THRESHOLD) {
    return { surface: "center", collapsed: true }
  }

  // 3 — they are looking right at it and the surface can host a card. No toast:
  // this is the double-notification rule.
  if (ctx.watching && ctx.hasInlineHost) {
    return { surface: "inline" }
  }

  // 4 — watching, but nowhere to put a card.
  if (ctx.watching && ctx.origin.kind !== "background") {
    return { surface: "toast" }
  }

  // 5 — a lasting condition belongs on a steady-state badge, not an event
  // surface that re-fires on every retry.
  if (diag.persistent) {
    return { surface: "badge", banner: diag.severity === "fatal" }
  }

  // 6 — it happened where they could not see it.
  return { surface: "center" }
}
