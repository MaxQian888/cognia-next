import type { Emit } from "../sessions/types.ts"
import type { HostCommand } from "../../shared/wire/inbound.ts"
export type CommandLedger = Map<string, Map<string, boolean>>

/**
 * ADR-0090 Phase 3 — command idempotency. A `commandId` the session already
 * processed is acknowledged (`command_ack { duplicate: true }`) and dropped,
 * so at-least-once senders (AgentExecutionHandle, the work-submission sweep,
 * a HostState redrive) can retry safely.
 *
 * The ledger lives OUTSIDE the session object on purpose. Anthropic sessions
 * are retired from `sessions` on every `session_ended`, so a ledger hung off
 * the live session forgot every id the moment the turn finished, and a retry
 * that landed after that re-ran the whole turn. The ledger is an LRU of
 * `RECENT_COMMAND_SESSIONS` sessions, each remembering
 * `RECENT_COMMAND_IDS_PER_SESSION` ids, so a closed session's ids outlive it
 * for as long as any at-least-once sender would retry.
 *
 * Returns true when the message was dropped. Exported for the co-located test,
 * which injects its own ledger.
 */
export const RECENT_COMMAND_SESSIONS = 256

export const RECENT_COMMAND_IDS_PER_SESSION = 128

const recentCommandIds: CommandLedger = new Map()

export function dropDuplicateCommand(
  _sessionsMap: unknown,
  msg: Pick<HostCommand, "sessionId" | "commandId">,
  emitFn: Emit,
  ledger: CommandLedger = recentCommandIds
) {
  if (!msg?.commandId || !msg?.sessionId) return false
  let ids = ledger.get(msg.sessionId)
  if (ids) {
    // LRU touch: a session that is still being driven stays warm.
    ledger.delete(msg.sessionId)
    ledger.set(msg.sessionId, ids)
  } else {
    ids = new Map()
    ledger.set(msg.sessionId, ids)
    if (ledger.size > RECENT_COMMAND_SESSIONS) {
      ledger.delete(ledger.keys().next().value!)
    }
  }
  if (ids.has(msg.commandId)) {
    emitFn({
      type: "command_ack",
      sessionId: msg.sessionId,
      commandId: msg.commandId,
      duplicate: true,
    })
    return true
  }
  ids.set(msg.commandId, true)
  if (ids.size > RECENT_COMMAND_IDS_PER_SESSION) {
    ids.delete(ids.keys().next().value!)
  }
  return false
}
