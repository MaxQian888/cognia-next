import type { ChatSession } from "@cognia/agent-config-types"

export type SessionWriteOperation =
  "send-message" | "continue-run" | "title" | "metadata" | "workspace-move" | "branch" | "delete"

export class SessionHandoffLockedError extends Error {
  readonly code = "session_handoff_locked"

  constructor(
    readonly sessionId: string,
    readonly ticketId: string,
    readonly operation: SessionWriteOperation
  ) {
    super(`Session ${sessionId} is read-only while handoff ${ticketId} is ${operation}-blocked`)
    this.name = "SessionHandoffLockedError"
  }
}

/**
 * The single write gate for sessions participating in a cross-host handoff.
 * Handoff protocol transitions update rows directly inside their own Dexie
 * transactions; every ordinary product mutation must pass through this guard.
 */
export function assertSessionWritable(
  session: Pick<ChatSession, "id" | "handoffLock"> | null | undefined,
  operation: SessionWriteOperation
): void {
  if (!session?.handoffLock) return
  throw new SessionHandoffLockedError(session.id, session.handoffLock.ticketId, operation)
}
