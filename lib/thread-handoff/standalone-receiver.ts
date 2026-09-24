import type { CanonicalSession } from "@cognia/agent-config-types/canonical-session"
import type {
  ThreadHandoffPreflight,
  ThreadHandoffTicket,
} from "@cognia/agent-config-types/thread-handoff"

import { receiveThreadHandoffAttachments } from "./attachments"
import { transport } from "@/lib/tauri/transport-instance"
import {
  importHandoffSession,
  canonicalTurnToHandoffMessage,
} from "@/lib/chat/import-handoff-session"
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
  if (!dependencies.environment) await receiveThreadHandoffAttachments(frame.ticket, transport)
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
  sessionId: string,
  handoffLock: import("@cognia/agent-config-types").ChatSession["handoffLock"],
  continuation: ThreadHandoffTicket["continuation"]
): Promise<void> {
  // The marker is written by the import itself, not patched on afterwards:
  // a retry (the first accept crashed between the import and the ticket
  // transaction) must recognise its own row as a prior handoff, or the
  // collision guard diverts to a fresh id and the accept can never complete.
  const imported = await importHandoffSession({
    sessionId,
    title: envelope.header.title,
    messages: envelope.turns.map(canonicalTurnToHandoffMessage),
    historicalState: envelope,
    // Preflight validates these target capabilities. Source machine paths and
    // permission modes must not become target execution authority.
    meta: { model: continuation.model, provider: continuation.providerOverride },
    handoffSource: "thread-handoff",
    handoffLock,
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
    {
      now,
      importSession:
        dependencies.importSession ??
        ((envelope, sessionId) =>
          importCanonicalSession(
            envelope,
            sessionId,
            {
              ticketId: prepared.ticket.ticketId,
              state: "frozen",
              targetHostRef: prepared.ticket.target.hostRef,
              targetSessionId: sessionId,
              at: now,
            },
            prepared.ticket.continuation
          )),
    }
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
