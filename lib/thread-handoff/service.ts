import type {
  CanonicalSession,
  SessionFidelity,
} from "@cognia/agent-config-types/canonical-session"
import type {
  ThreadHandoffBlocker,
  ThreadHandoffPreflight,
  ThreadHandoffRole,
  ThreadHandoffTicket,
} from "@cognia/agent-config-types/thread-handoff"
import {
  validateThreadHandoffRefs,
  validateThreadHandoffTicket,
} from "@cognia/agent-config-types/thread-handoff"

import { getDb } from "@/lib/db/schema"
import { ThreadHandoffConflictError } from "@/lib/db/thread-handoff-tickets"

function assertTicket(ticket: ThreadHandoffTicket): void {
  const errors = [...validateThreadHandoffTicket(ticket), ...validateThreadHandoffRefs(ticket)]
  if (errors.length > 0) throw new Error(`invalid thread handoff ticket: ${errors.join("; ")}`)
}

export async function offerThreadHandoff(
  proposed: ThreadHandoffTicket,
  at = Date.now()
): Promise<ThreadHandoffTicket> {
  assertTicket(proposed)
  if (proposed.role !== "source") throw new Error("thread_handoff_offer requires source role")
  const db = getDb()
  return db.transaction("rw", db.threadHandoffTickets, db.sessions, async () => {
    const existing = await db.threadHandoffTickets.get([proposed.ticketId, "source"])
    if (existing) return existing
    if (proposed.state !== "preparing") {
      throw new Error("thread_handoff_offer requires a preparing ticket")
    }
    const session = await db.sessions.get(proposed.source.sessionId)
    if (!session) throw new Error("thread_handoff_source_session_not_found")
    if (session.handoffLock && session.handoffLock.ticketId !== proposed.ticketId) {
      throw new Error("thread_handoff_source_already_locked")
    }

    const frozen: ThreadHandoffTicket = {
      ...proposed,
      state: "frozen",
      updatedAt: at,
      history: [...proposed.history, { state: "frozen", at, actor: proposed.source.hostRef }],
    }
    assertTicket(frozen)
    await db.threadHandoffTickets.add(frozen)
    await db.sessions.update(session.id, {
      handoffLock: {
        ticketId: frozen.ticketId,
        state: "frozen",
        targetHostRef: frozen.target.hostRef,
        targetSessionId: frozen.target.sessionId,
        at,
      },
      updatedAt: at,
    })
    return frozen
  })
}

export interface ThreadHandoffPreflightEnvironment {
  capabilities: string[]
  hostOperations: Array<{ feature: string; operation?: string }>
  providerRefs: string[]
  models: string[]
  credentialProfileRefs: string[]
  workspaceRefs: string[]
  attachmentRefs: string[]
  protocolVersion: number
  nativeRuntimeAvailable: boolean
}

export function preflightThreadHandoff(
  ticket: ThreadHandoffTicket,
  environment: ThreadHandoffPreflightEnvironment,
  checkedAt = Date.now()
): ThreadHandoffPreflight {
  assertTicket(ticket)
  const blockers: ThreadHandoffBlocker[] = []
  const missing = (
    required: readonly string[],
    available: readonly string[],
    kind: ThreadHandoffBlocker["kind"]
  ): void => {
    for (const ref of required) {
      if (!available.includes(ref)) blockers.push({ kind, ref, severity: "blocking" })
    }
  }

  missing(ticket.requirements.capabilities, environment.capabilities, "capability-missing")
  missing(ticket.requirements.providerRefs, environment.providerRefs, "provider-unavailable")
  missing(ticket.requirements.models, environment.models, "model-unavailable")
  missing(
    ticket.requirements.credentialProfileRefs,
    environment.credentialProfileRefs,
    "credential-missing"
  )
  for (const operation of ticket.requirements.hostOperations) {
    const supported = environment.hostOperations.some(
      (candidate) =>
        candidate.feature === operation.feature &&
        (operation.operation === undefined || candidate.operation === operation.operation)
    )
    if (!supported) {
      blockers.push({
        kind: "host-operation-missing",
        ref: operation.operation
          ? `${operation.feature}:${operation.operation}`
          : operation.feature,
        severity: "blocking",
      })
    }
  }
  if (
    ticket.requirements.minProtocolVersion !== undefined &&
    environment.protocolVersion < ticket.requirements.minProtocolVersion
  ) {
    blockers.push({
      kind: "protocol-incompatible",
      ref: String(ticket.requirements.minProtocolVersion),
      severity: "blocking",
    })
  }
  if (
    ticket.project.workspaceRef &&
    !environment.workspaceRefs.includes(ticket.project.workspaceRef)
  ) {
    blockers.push({
      kind: "workspace-unavailable",
      ref: ticket.project.workspaceRef,
      severity: "blocking",
    })
  }
  for (const attachment of ticket.attachments) {
    const ref = attachment.ref ?? attachment.attachmentId
    if (attachment.carriage === "by-ref" && !environment.attachmentRefs.includes(ref)) {
      blockers.push({ kind: "attachment-unresolvable", ref, severity: "blocking" })
    }
  }

  let achievableFidelity: SessionFidelity = ticket.continuation.fidelity
  if (ticket.continuation.sdkSessionId && !environment.nativeRuntimeAvailable) {
    achievableFidelity = ticket.continuation.seedTranscript ? "contextual" : "unsupported"
    blockers.push({
      kind: "host-operation-missing",
      ref: `runtime:${ticket.continuation.sourceRuntime}`,
      severity: achievableFidelity === "unsupported" ? "blocking" : "degraded",
      detail:
        achievableFidelity === "contextual"
          ? "Native runtime handle is unavailable; continuation will use the seed transcript."
          : "Native runtime handle is unavailable and no seed transcript was provided.",
    })
  }

  return {
    ok: blockers.every((blocker) => blocker.severity !== "blocking"),
    blockers,
    achievableFidelity,
    checkedAt,
  }
}

export interface AcceptThreadHandoffInput {
  ticket: ThreadHandoffTicket
  envelope: CanonicalSession
}

export interface AcceptedThreadHandoffProof {
  ticketId: string
  state: "accepted"
  targetHostRef: string
  targetSessionId: string
  sequenceDigest: string
}

export async function acceptThreadHandoff(
  input: AcceptThreadHandoffInput,
  deps: {
    now?: number
    importSession: (envelope: CanonicalSession, sessionId: string) => Promise<void>
  }
): Promise<{ ticket: ThreadHandoffTicket; proof: AcceptedThreadHandoffProof }> {
  assertTicket(input.ticket)
  if (input.ticket.role !== "target") throw new Error("thread_handoff_accept requires target role")
  if (!input.ticket.preflight?.ok) throw new Error("thread_handoff_preflight_blocked")
  const at = deps.now ?? Date.now()
  // The TTL is what lets the expiry sweep retire a stranded source offer and
  // release its `handoffLock` without asking the peer. That is only sound if an
  // expired offer can no longer be accepted, so enforce it here rather than
  // leaving expiry a display-only field.
  if (input.ticket.expiresAt <= at) throw new Error("thread_handoff_offer_expired")
  const sessionId = input.ticket.target.sessionId ?? `handoff-${input.ticket.ticketId}`
  const db = getDb()
  // Claim the target row in ONE transaction. Reading and then adding across
  // two awaits let a concurrent accept (a retry fired while the first was still
  // inside `importSession`) see no row, and the loser's `add()` then rejected
  // with a raw Dexie ConstraintError instead of taking the idempotent path.
  const existing = await db.transaction("rw", db.threadHandoffTickets, async () => {
    const current = await db.threadHandoffTickets.get([input.ticket.ticketId, "target"])
    if (current) return current
    const preparing: ThreadHandoffTicket = {
      ...input.ticket,
      role: "target",
      state: "preparing",
      target: { ...input.ticket.target, sessionId },
      updatedAt: at,
    }
    assertTicket(preparing)
    await db.threadHandoffTickets.add(preparing)
    return preparing
  })
  if (existing.state === "accepted" || existing.state === "committed") {
    return {
      ticket: existing,
      proof: acceptedProof(existing, existing.target.sessionId ?? sessionId),
    }
  }

  await deps.importSession(input.envelope, sessionId)
  const accepted = await db.transaction("rw", db.threadHandoffTickets, db.sessions, async () => {
    const current = await db.threadHandoffTickets.get([input.ticket.ticketId, "target"])
    if (!current) throw new Error("thread_handoff_target_ticket_missing")
    if (current.state === "accepted" || current.state === "committed") return current
    if (current.state !== "preparing" && current.state !== "frozen") {
      throw new ThreadHandoffConflictError(current, "accepted")
    }
    const history = [...current.history]
    if (current.state === "preparing") {
      history.push({ state: "frozen", at, actor: current.target.hostRef })
    }
    history.push({ state: "accepted", at, actor: current.target.hostRef })
    const next: ThreadHandoffTicket = {
      ...current,
      state: "accepted",
      target: { ...current.target, sessionId },
      updatedAt: at,
      history,
    }
    const updated = await db.sessions.update(sessionId, {
      handoffLock: {
        ticketId: next.ticketId,
        state: "frozen",
        targetHostRef: next.target.hostRef,
        targetSessionId: sessionId,
        at,
      },
      updatedAt: at,
    })
    if (updated !== 1) throw new Error("thread_handoff_imported_session_missing")
    await db.threadHandoffTickets.put(next)
    return next
  })
  return { ticket: accepted, proof: acceptedProof(accepted, sessionId) }
}

function acceptedProof(ticket: ThreadHandoffTicket, sessionId: string): AcceptedThreadHandoffProof {
  return {
    ticketId: ticket.ticketId,
    state: "accepted",
    targetHostRef: ticket.target.hostRef,
    targetSessionId: sessionId,
    sequenceDigest: ticket.continuation.sequenceDigest,
  }
}

export interface SourceCommitProof {
  ticketId: string
  state: "committed"
  sourceHostRef: string
  sourceSessionId: string
  sequenceDigest: string
}

export type CommitThreadHandoffInput =
  | {
      ticketId: string
      role: "source"
      at?: number
      acceptedProof: AcceptedThreadHandoffProof
    }
  | {
      ticketId: string
      role: "target"
      at?: number
      sourceCommitProof: SourceCommitProof
    }

export async function commitThreadHandoff(
  input: CommitThreadHandoffInput
): Promise<{ ticket: ThreadHandoffTicket; proof: SourceCommitProof | { state: "committed" } }> {
  const at = input.at ?? Date.now()
  const db = getDb()
  return db.transaction("rw", db.threadHandoffTickets, db.sessions, async () => {
    const current = await db.threadHandoffTickets.get([input.ticketId, input.role])
    if (!current) throw new Error("thread_handoff_ticket_not_found")
    if (current.state === "committed") {
      return {
        ticket: current,
        proof: input.role === "source" ? sourceProof(current) : { state: "committed" as const },
      }
    }

    if (input.role === "source") {
      const proof = input.acceptedProof
      if (
        current.state !== "frozen" ||
        proof.ticketId !== current.ticketId ||
        proof.state !== "accepted" ||
        proof.targetHostRef !== current.target.hostRef ||
        proof.sequenceDigest !== current.continuation.sequenceDigest
      ) {
        throw new Error("thread_handoff_accepted_proof_invalid")
      }
      const committed: ThreadHandoffTicket = {
        ...current,
        state: "committed",
        target: { ...current.target, sessionId: proof.targetSessionId },
        updatedAt: at,
        history: [
          ...current.history,
          { state: "accepted", at, actor: proof.targetHostRef },
          { state: "committed", at, actor: current.source.hostRef },
        ],
      }
      await db.sessions.update(current.source.sessionId, {
        handoffLock: {
          ticketId: current.ticketId,
          state: "committed",
          targetHostRef: current.target.hostRef,
          targetSessionId: proof.targetSessionId,
          at,
        },
        updatedAt: at,
      })
      await db.threadHandoffTickets.put(committed)
      return { ticket: committed, proof: sourceProof(committed) }
    }

    const proof = input.sourceCommitProof
    if (
      current.state !== "accepted" ||
      proof.ticketId !== current.ticketId ||
      proof.state !== "committed" ||
      proof.sourceHostRef !== current.source.hostRef ||
      proof.sourceSessionId !== current.source.sessionId ||
      proof.sequenceDigest !== current.continuation.sequenceDigest
    ) {
      throw new Error("thread_handoff_commit_proof_invalid")
    }
    const committed: ThreadHandoffTicket = {
      ...current,
      state: "committed",
      updatedAt: at,
      history: [...current.history, { state: "committed", at, actor: current.target.hostRef }],
    }
    const sessionId = current.target.sessionId
    if (!sessionId) throw new Error("thread_handoff_target_session_missing")
    await db.sessions.update(sessionId, { handoffLock: undefined, updatedAt: at })
    await db.threadHandoffTickets.put(committed)
    return { ticket: committed, proof: { state: "committed" as const } }
  })
}

function sourceProof(ticket: ThreadHandoffTicket): SourceCommitProof {
  return {
    ticketId: ticket.ticketId,
    state: "committed",
    sourceHostRef: ticket.source.hostRef,
    sourceSessionId: ticket.source.sessionId,
    sequenceDigest: ticket.continuation.sequenceDigest,
  }
}

export interface AbortThreadHandoffInput {
  ticketId: string
  role: ThreadHandoffRole
  at?: number
  peerDisposition?: "not-accepted" | "deleted"
}

export async function abortThreadHandoff(
  input: AbortThreadHandoffInput
): Promise<ThreadHandoffTicket> {
  const at = input.at ?? Date.now()
  const db = getDb()
  return db.transaction("rw", db.threadHandoffTickets, db.sessions, db.messages, async () => {
    const current = await db.threadHandoffTickets.get([input.ticketId, input.role])
    if (!current) throw new Error("thread_handoff_ticket_not_found")
    if (current.state === "aborted") return current
    if (current.state === "committed") throw new ThreadHandoffConflictError(current, "aborted")
    if (current.state === "frozen" && input.role === "source" && !input.peerDisposition) {
      throw new Error("thread_handoff_abort requires proof that the target did not accept")
    }
    if (current.state === "accepted") {
      if (input.role !== "target" || input.peerDisposition !== "deleted") {
        throw new Error("thread_handoff_abort requires proof that the target copy was deleted")
      }
      const sessionId = current.target.sessionId
      if (sessionId) {
        await db.messages.where("sessionId").equals(sessionId).delete()
        await db.sessions.delete(sessionId)
      }
    }

    const aborted: ThreadHandoffTicket = {
      ...current,
      state: "aborted",
      updatedAt: at,
      history: [
        ...current.history,
        { state: "aborted", at, actor: input.role, note: input.peerDisposition },
      ],
    }
    if (input.role === "source") {
      await db.sessions.update(current.source.sessionId, { handoffLock: undefined, updatedAt: at })
    }
    await db.threadHandoffTickets.put(aborted)
    return aborted
  })
}
