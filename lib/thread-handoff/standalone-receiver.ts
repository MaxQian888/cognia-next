import type { CanonicalSession } from "@cognia/agent-config-types/canonical-session"
import type {
  ThreadHandoffPreflight,
  ThreadHandoffTicket,
} from "@cognia/agent-config-types/thread-handoff"

import { importHandoffSession } from "@/lib/chat/import-handoff-session"
import { issueHostAdminLease } from "@/lib/tauri/admin-lease"

import { ThreadHandoffClient } from "./client"
import { buildThreadHandoffPreflightEnvironment } from "./host-dispatch"
import type { ThreadHandoffOfferFrame } from "./orchestrator"
import {
  acceptThreadHandoff,
  commitThreadHandoff,
  preflightThreadHandoff,
  type AcceptedThreadHandoffProof,
  type SourceCommitProof,
  type ThreadHandoffPreflightEnvironment,
} from "./service"

export interface PreparedInboundThreadHandoff {
  frame: ThreadHandoffOfferFrame
  ticket: ThreadHandoffTicket
  preflight: ThreadHandoffPreflight
}

export async function prepareInboundThreadHandoff(
  frame: ThreadHandoffOfferFrame,
  ownDeviceId: string,
  dependencies: {
    environment?: (ticket: ThreadHandoffTicket) => Promise<ThreadHandoffPreflightEnvironment>
    now?: () => number
  } = {}
): Promise<PreparedInboundThreadHandoff | null> {
  if (
    frame.ticket.role !== "target" ||
    frame.ticket.target.kind !== "mobile" ||
    frame.ticket.target.hostRef !== ownDeviceId
  ) {
    return null
  }
  const environment = await (dependencies.environment ?? buildThreadHandoffPreflightEnvironment)(
    frame.ticket
  )
  const preflight = preflightThreadHandoff(
    frame.ticket,
    environment,
    dependencies.now?.() ?? Date.now()
  )
  return {
    frame,
    preflight,
    ticket: { ...frame.ticket, preflight },
  }
}

async function importCanonicalSession(
  envelope: CanonicalSession,
  sessionId: string
): Promise<void> {
  // The marker is written by the import itself, not patched on afterwards:
  // a retry (the first accept crashed between the import and the ticket
  // transaction) must recognise its own row as a prior handoff, or the
  // collision guard diverts to a fresh id and the accept can never complete.
  const imported = await importHandoffSession({
    sessionId,
    title: envelope.header.title,
    messages: envelope.turns.map((turn) => ({ role: turn.role, content: turn.text })),
    handoffSource: "thread-handoff",
  })
  if (imported.id !== sessionId) throw new Error("thread_handoff_target_session_collision")
}

export interface CompleteInboundThreadHandoffDependencies {
  importSession?: (envelope: CanonicalSession, sessionId: string) => Promise<void>
  issueLease?: (operations: string[]) => Promise<{ token: string }>
  commitSource?: (
    ticketId: string,
    proof: AcceptedThreadHandoffProof,
    adminLease: string
  ) => Promise<{ proof: SourceCommitProof }>
  commitTarget?: typeof commitThreadHandoff
  now?: () => number
}

export async function completeInboundThreadHandoff(
  prepared: PreparedInboundThreadHandoff,
  dependencies: CompleteInboundThreadHandoffDependencies = {}
): Promise<ThreadHandoffTicket> {
  if (!prepared.preflight.ok) throw new Error("thread_handoff_preflight_blocked")
  const now = dependencies.now?.() ?? Date.now()
  const accepted = await acceptThreadHandoff(
    { ticket: prepared.ticket, envelope: prepared.frame.envelope },
    { now, importSession: dependencies.importSession ?? importCanonicalSession }
  )
  const lease = await (dependencies.issueLease ?? ((ops) => issueHostAdminLease(ops)))([
    "thread_handoff_commit",
  ])
  const client = new ThreadHandoffClient()
  const source = await (
    dependencies.commitSource ??
    ((ticketId, proof, adminLease) => client.commitSource(ticketId, proof, adminLease))
  )(accepted.ticket.ticketId, accepted.proof, lease.token)
  const target = await (dependencies.commitTarget ?? commitThreadHandoff)({
    ticketId: accepted.ticket.ticketId,
    role: "target",
    sourceCommitProof: source.proof,
    at: dependencies.now?.() ?? Date.now(),
  })
  return target.ticket
}

export async function resumeAcceptedThreadHandoff(
  ticket: ThreadHandoffTicket,
  dependencies: Omit<CompleteInboundThreadHandoffDependencies, "importSession"> = {}
): Promise<ThreadHandoffTicket> {
  if (ticket.role !== "target" || ticket.state !== "accepted" || !ticket.target.sessionId) {
    throw new Error("thread_handoff_target_not_accepted")
  }
  const acceptedProof: AcceptedThreadHandoffProof = {
    ticketId: ticket.ticketId,
    state: "accepted",
    targetHostRef: ticket.target.hostRef,
    targetSessionId: ticket.target.sessionId,
    sequenceDigest: ticket.continuation.sequenceDigest,
  }
  const lease = await (dependencies.issueLease ?? ((ops) => issueHostAdminLease(ops)))([
    "thread_handoff_commit",
  ])
  const client = new ThreadHandoffClient()
  const source = await (
    dependencies.commitSource ??
    ((ticketId, proof, adminLease) => client.commitSource(ticketId, proof, adminLease))
  )(ticket.ticketId, acceptedProof, lease.token)
  const target = await (dependencies.commitTarget ?? commitThreadHandoff)({
    ticketId: ticket.ticketId,
    role: "target",
    sourceCommitProof: source.proof,
    at: dependencies.now?.() ?? Date.now(),
  })
  return target.ticket
}
