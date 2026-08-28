import type {
  ThreadHandoffRole,
  ThreadHandoffState,
  ThreadHandoffTicket,
} from "@cognia/agent-config-types/thread-handoff"
import {
  canTransition,
  validateThreadHandoffRefs,
  validateThreadHandoffTicket,
} from "@cognia/agent-config-types/thread-handoff"

import { getDb } from "./schema"

export class ThreadHandoffConflictError extends Error {
  readonly code = "thread_handoff_conflict"

  constructor(
    readonly current: ThreadHandoffTicket,
    requested: ThreadHandoffState
  ) {
    super(`cannot transition thread handoff from ${current.state} to ${requested}`)
    this.name = "ThreadHandoffConflictError"
  }
}

function assertSafeTicket(ticket: ThreadHandoffTicket): void {
  const errors = [...validateThreadHandoffTicket(ticket), ...validateThreadHandoffRefs(ticket)]
  if (errors.length > 0) throw new Error(`invalid thread handoff ticket: ${errors.join("; ")}`)
}

export async function saveThreadHandoffTicket(ticket: ThreadHandoffTicket): Promise<void> {
  assertSafeTicket(ticket)
  await getDb().threadHandoffTickets.put(ticket)
}

export function getThreadHandoffTicket(
  ticketId: string,
  role: ThreadHandoffRole
): Promise<ThreadHandoffTicket | undefined> {
  return getDb().threadHandoffTickets.get([ticketId, role])
}

export interface TransitionThreadHandoffInput {
  ticketId: string
  role: ThreadHandoffRole
  to: ThreadHandoffState
  at: number
  actor?: string
  note?: string
}

export async function transitionThreadHandoffTicket(
  input: TransitionThreadHandoffInput
): Promise<ThreadHandoffTicket> {
  const db = getDb()
  return db.transaction("rw", db.threadHandoffTickets, async () => {
    const current = await db.threadHandoffTickets.get([input.ticketId, input.role])
    if (!current)
      throw new Error(`thread handoff ticket not found: ${input.ticketId}/${input.role}`)
    if (current.state === input.to) return current
    if (!canTransition(current.state, input.to)) {
      throw new ThreadHandoffConflictError(current, input.to)
    }

    const next: ThreadHandoffTicket = {
      ...current,
      state: input.to,
      updatedAt: input.at,
      history: [
        ...current.history,
        { state: input.to, at: input.at, actor: input.actor, note: input.note },
      ],
    }
    assertSafeTicket(next)
    await db.threadHandoffTickets.put(next)
    return next
  })
}

export interface ThreadHandoffSweepResult {
  abortedPreparing: number
  /** Expired `frozen` source offers retired, releasing their `handoffLock`. */
  abortedFrozenSource: number
  stranded: number
}

export async function sweepExpiredThreadHandoffTickets(
  now: number
): Promise<ThreadHandoffSweepResult> {
  const db = getDb()
  return db.transaction("rw", db.threadHandoffTickets, db.sessions, async () => {
    const expired = await db.threadHandoffTickets.where("expiresAt").belowOrEqual(now).toArray()
    let abortedPreparing = 0
    let abortedFrozenSource = 0
    let stranded = 0

    const retire = async (ticket: ThreadHandoffTicket, note: string): Promise<void> => {
      await db.threadHandoffTickets.put({
        ...ticket,
        state: "aborted",
        updatedAt: now,
        history: [...ticket.history, { state: "aborted", at: now, actor: "sweeper", note }],
      })
    }

    for (const ticket of expired) {
      if (ticket.state === "preparing") {
        await retire(ticket, "preflight expired")
        abortedPreparing += 1
      } else if (ticket.state === "frozen" && ticket.role === "source") {
        // The offer's TTL has run out, and `acceptThreadHandoff` refuses an
        // expired ticket — so no target can still be mid-accept and there is
        // no second writable copy to race. Leaving it frozen is what made a
        // handoff the other device never answered a permanently read-only
        // conversation: `startThreadHandoff` freezes the source in the same
        // transaction that sets `handoffLock`, so a source ticket is NEVER
        // `preparing` by the time it can expire, and the branch above could
        // never release a lock.
        await retire(ticket, "offer expired without a response")
        await db.sessions.update(ticket.source.sessionId, {
          handoffLock: undefined,
          updatedAt: now,
        })
        abortedFrozenSource += 1
      } else if (ticket.state === "frozen" || ticket.state === "accepted") {
        // An `accepted` ticket (either role) already has a target copy, and a
        // frozen TARGET ticket is the peer's half of one. Those need proof
        // from the peer and are surfaced to the recovery UI.
        stranded += 1
      }
    }

    return { abortedPreparing, abortedFrozenSource, stranded }
  })
}
