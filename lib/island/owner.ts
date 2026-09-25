/**
 * Owner resolution and routing, shared by the island, the Fleet page and the
 * Attention panel.
 *
 * Before this, each of the three surfaces derived "where does this belong" on
 * its own, which is how the same pending item ended up with three different
 * open buttons. One module now answers three questions: which surface owns a
 * task, what identity two observations of it share, and which route opens it.
 */

import {
  getExternalApprovalTarget,
  isExternalAgentApprovalRequestId,
} from "@/lib/ai/agent/external/session/chat-decision-bridge"
import type { AttentionItem } from "@/lib/attention/types"
import { acpSessionOwnerFacts } from "@/lib/fleet/acp-session-registry"
import type { FleetSession } from "@/lib/fleet/types"
import type { FleetOwnerRef } from "./types"

/**
 * Owner of a monitored session.
 *
 * A `cognia` session is one of our own runtimes observed through the canonical
 * journal, so it belongs to a Cognia surface: a team run, the conversation it
 * runs in, or an execution run. Every other agent is an external CLI whose own
 * terminal is the owner.
 *
 * `isConversation` says whether a session id is a Cognia conversation. A chat
 * turn always carries a run id, so without it every chat turn resolved to the
 * run cockpit — a second row beside the conversation's own approval, a Stop
 * nothing could honour, and an "open" that left the chat behind. Callers that
 * pass it must pass the same answer everywhere they compare identities.
 */
export function fleetSessionOwner(
  session: FleetSession,
  isConversation: (sessionId: string) => boolean = () => false
): FleetOwnerRef {
  if (session.agent !== "cognia") {
    return {
      kind: "external",
      agent: session.agent,
      sessionId: session.sessionId,
      ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {}),
      ...(session.externalAgentId ? { agentId: session.externalAgentId } : {}),
      ...(session.chatSessionId ? { chatSessionId: session.chatSessionId } : {}),
    }
  }
  if (session.agentTeamId || session.agentTeamRunId) {
    return {
      kind: "team",
      ...(session.agentTeamId ? { teamId: session.agentTeamId } : {}),
      ...(session.agentTeamRunId ? { runId: session.agentTeamRunId } : {}),
    }
  }
  if (isConversation(session.sessionId)) return { kind: "chat", sessionId: session.sessionId }
  if (session.executionRunId) return { kind: "run", runId: session.executionRunId }
  return { kind: "chat", sessionId: session.sessionId }
}

/** Owner of a pending item from the Control Center aggregation. */
export function attentionOwner(item: AttentionItem): FleetOwnerRef | null {
  // Legacy aggregation calls these "team" rows, but plan and budget gates
  // belong to the root-mounted approval host and may have no run at all.
  if (item.kind === "hitl-gate" && item.gate) {
    return {
      kind: "gate",
      gateKey: { ...item.gate.key },
      ...(item.gate.sessionId ? { sessionId: item.gate.sessionId } : {}),
    }
  }
  switch (item.source) {
    case "chat": {
      // An external agent's approval is pushed into the chat approval queue
      // by `registerExternalApproval`. When the ACP fleet projection knows the
      // session the ask came from, the row folds into that session's external
      // owner — one row, not a session plus a duplicate "chat" approval.
      const requestId = item.approval?.requestId
      if (requestId && isExternalAgentApprovalRequestId(requestId)) {
        const target = getExternalApprovalTarget(requestId)
        const facts = target ? acpSessionOwnerFacts(target.externalSessionId) : undefined
        if (target && facts) {
          return {
            kind: "external",
            agent: facts.agent,
            sessionId: target.externalSessionId,
            agentId: target.agentId,
            chatSessionId: target.chatSessionId,
          }
        }
      }
      return item.sessionId
        ? { kind: "chat", sessionId: item.sessionId, requestId: item.approval?.requestId }
        : null
    }
    case "team":
      // Only gates carry this source, and they resolved above. A team row
      // without its gate has no surface that could answer it.
      return null
    case "run":
      return item.runId
        ? {
            kind: "run",
            runId: item.runId,
            ...(item.interrupt ? { interruptId: item.interrupt.id } : {}),
          }
        : null
    case "fleet":
      return item.fleetSession ? fleetSessionOwner(item.fleetSession) : null
  }
}

/**
 * Stable merge identity.
 *
 * Two observations merge only when this string matches exactly. An owner whose
 * discriminating ids are missing yields `null`, which the projection reads as
 * "cannot prove these are the same thing" and keeps as its own row rather than
 * guessing from a title.
 */
export function taskIdentity(owner: FleetOwnerRef): string | null {
  switch (owner.kind) {
    case "chat":
      return owner.sessionId ? `chat:${owner.sessionId}` : null
    case "team": {
      if (!owner.teamId && !owner.runId) return null
      return `team:${owner.teamId ?? ""}:${owner.runId ?? ""}`
    }
    case "run":
      return owner.runId ? `run:${owner.runId}` : null
    case "gate":
      return owner.gateKey.scope && owner.gateKey.id
        ? `gate:${encodeURIComponent(owner.gateKey.scope)}:${encodeURIComponent(owner.gateKey.id)}`
        : null
    case "external":
      return owner.sessionId ? `external:${owner.agent}:${owner.sessionId}` : null
  }
}

/**
 * Where the main window navigates to open an owner.
 *
 * `null` for an external agent: its owner is a terminal, not a route, and the
 * island offers focus-terminal or reveal-transcript there instead. Returning a
 * route we cannot honour would be the exact affordance-that-does-nothing this
 * refactor removes.
 */
export function ownerRoute(owner: FleetOwnerRef): string | null {
  switch (owner.kind) {
    case "chat":
    case "gate":
      return "/"
    case "team":
      return owner.teamId ? `/squads?id=${encodeURIComponent(owner.teamId)}` : "/squads"
    case "run":
      return `/agent-runs?run=${encodeURIComponent(owner.runId)}`
    case "external":
      // A renderer-managed (ACP) session DOES have a route: the chat it is
      // bound to, or the external-agents page that owns the agent. A
      // hook-observed CLI keeps `null` — its owner is a terminal, and the
      // island offers focus-terminal there instead.
      if (owner.chatSessionId) return "/"
      return owner.agentId ? "/me/external-agents" : null
  }
}
