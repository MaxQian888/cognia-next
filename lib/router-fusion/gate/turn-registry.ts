/**
 * Which chat sessions have a Router + Fusion turn in flight in this window
 * (ADR-0188), readable synchronously by the shared event handler.
 *
 * The sidecar's SDK frames can arrive before the controller has cached the
 * send, so "is this session's turn ledgered?" cannot wait for that cache. The
 * controller marks the session right after the run is created and before the
 * prompt is dispatched; the turn's end clears it. On the off path nothing ever
 * marks a session, so every lookup is a miss on an empty map.
 *
 * It also carries the turn's bypass notice: a fault in the middle of a turn
 * (the ledger became unavailable, the renderer stopped answering) must still
 * reach the message the turn produces, which is sealed later.
 *
 * Zero imports on purpose: shared modules load it with the gate.
 */

export interface FusionTurnBypass {
  code: string
  justTripped: boolean
}

interface FusionTurn {
  runId: string
  bypass: FusionTurnBypass | null
}

const turns = new Map<string, FusionTurn>()

export function markFusionTurn(sessionId: string, runId: string): void {
  turns.set(sessionId, { runId, bypass: null })
}

/** The run id of the session's ledgered turn in flight, if any. */
export function fusionTurnOf(sessionId: string): string | undefined {
  return turns.get(sessionId)?.runId
}

/** Record that the turn continued unledgered; the first notice wins. */
export function noteFusionTurnBypass(sessionId: string, bypass: FusionTurnBypass): void {
  const turn = turns.get(sessionId)
  if (turn && !turn.bypass) turn.bypass = bypass
}

export function fusionTurnBypassOf(sessionId: string): FusionTurnBypass | null {
  return turns.get(sessionId)?.bypass ?? null
}

/** Every session with a ledgered turn in flight — for a host exit that ends them all at once. */
export function fusionTurnSessions(): string[] {
  return [...turns.keys()]
}

export function clearFusionTurn(sessionId: string): void {
  turns.delete(sessionId)
}

export function __resetFusionTurnsForTesting(): void {
  turns.clear()
}
