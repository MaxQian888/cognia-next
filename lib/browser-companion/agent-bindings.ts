/**
 * Keep conversation → browser bindings in step with what the Owner allows
 * (ADR-0228 §5–§6).
 *
 * A `browser-agent` submission binds its conversation to the browser it came
 * from, and the binding is what adds the browser tools to every later turn
 * (`lib/claude/build-options.ts`). A binding that outlived the Owner's
 * `browser.drive` grant — revoked in Settings, or the browser unpaired —
 * would keep offering tools the Host then refuses on every call. So bindings
 * are reconciled against the grant: dropped when it goes, restored when it
 * comes back. A browser that is merely offline keeps its bindings; it will
 * reconnect, and the engine already says "offline" in the meantime.
 */

export interface AgentBindingRow {
  sessionId?: string
  deviceId: string
}

export interface ReconcileBindingsDeps {
  /** The ledger's `browser-agent` submissions, newest first. */
  rows: readonly AgentBindingRow[]
  /** Whether the device still holds `browser.drive`. */
  driveAllowed: (deviceId: string) => Promise<boolean>
  isBound: (sessionId: string) => boolean
  bind: (sessionId: string, deviceId: string) => void
  unbind: (sessionId: string) => void
}

/** Answers how many bindings were added and dropped. */
export async function reconcileAgentBindings(
  deps: ReconcileBindingsDeps
): Promise<{ bound: number; unbound: number }> {
  const allowed = new Map<string, boolean>()
  const seen = new Set<string>()
  let bound = 0
  let unbound = 0
  for (const row of deps.rows) {
    if (!row.sessionId || seen.has(row.sessionId)) continue
    // Newest row wins: a conversation is bound to the browser that last
    // started it.
    seen.add(row.sessionId)
    if (!allowed.has(row.deviceId)) allowed.set(row.deviceId, await deps.driveAllowed(row.deviceId))
    if (allowed.get(row.deviceId)) {
      // An existing binding keeps its starting tab; only a missing one is made.
      if (!deps.isBound(row.sessionId)) {
        deps.bind(row.sessionId, row.deviceId)
        bound += 1
      }
    } else if (deps.isBound(row.sessionId)) {
      deps.unbind(row.sessionId)
      unbound += 1
    }
  }
  return { bound, unbound }
}

/** How often the desktop re-reads the grants behind its bindings. */
export const AGENT_BINDING_RECONCILE_MS = 15_000
