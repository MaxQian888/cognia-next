/**
 * Owner resolution and routing, shared by the island, the Fleet page and the
 * Attention panel.
 *
 * Before this, each of the three surfaces derived "where does this belong" on
 * its own, which is how the same pending item ended up with three different
 * open buttons. One module now answers three questions: which surface owns a
 * task, what identity two observations of it share, and which route opens it.
 */

import type { AttentionItem } from "@/lib/attention/types"
import type { FleetSession } from "@/lib/fleet/types"
import type { FleetOwnerRef, IslandSource } from "./types"

/**
 * Owner of a monitored session.
 *
 * A `cognia` session is one of our own runtimes observed through the canonical
 * journal, so it belongs to a Cognia surface: a team run, an execution run, or
 * the chat session it was started from. Every other agent is an external CLI
 * whose own terminal is the owner.
 */
export function fleetSessionOwner(session: FleetSession): FleetOwnerRef {
  if (session.agent !== "cognia") {
    return {
      kind: "external",
      agent: session.agent,
      sessionId: session.sessionId,
      ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {}),
    }
  }
  if (session.agentTeamId || session.agentTeamRunId) {
    return {
      kind: "team",
      ...(session.agentTeamId ? { teamId: session.agentTeamId } : {}),
      ...(session.agentTeamRunId ? { runId: session.agentTeamRunId } : {}),
    }
  }
  if (session.executionRunId) return { kind: "run", runId: session.executionRunId }
  return { kind: "chat", sessionId: session.sessionId }
}

/** Owner of a pending item from the Control Center aggregation. */
export function attentionOwner(item: AttentionItem): FleetOwnerRef | null {
  switch (item.source) {
    case "chat":
      return item.sessionId
        ? { kind: "chat", sessionId: item.sessionId, requestId: item.approval?.requestId }
        : null
    case "team":
      return item.teamId || item.runId
        ? {
            kind: "team",
            ...(item.teamId ? { teamId: item.teamId } : {}),
            ...(item.runId ? { runId: item.runId } : {}),
          }
        : null
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

/** Which of the four planes an owner belongs to. */
export function ownerSource(owner: FleetOwnerRef): IslandSource {
  return owner.kind
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
      return "/"
    case "team":
      return owner.teamId ? `/squads?id=${encodeURIComponent(owner.teamId)}` : "/squads"
    case "run":
      return `/agent-runs?run=${encodeURIComponent(owner.runId)}`
    case "external":
      return null
  }
}

/** Whether two owner refs designate the same task. */
export function sameOwner(a: FleetOwnerRef, b: FleetOwnerRef): boolean {
  const left = taskIdentity(a)
  return left !== null && left === taskIdentity(b)
}
