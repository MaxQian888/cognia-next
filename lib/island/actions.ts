"use client"

/**
 * Main-window execution of island intents.
 *
 * The overlay has no business permissions at all. It emits a typed intent and
 * this module re-validates it against the CURRENT projection before anything
 * happens: the row must still exist, the revision must not be older than the
 * one the row's capabilities were computed from, the capability must still be
 * true, and the referenced request id must still be the parked one. A click on
 * a row that changed under the user is rejected rather than replayed.
 *
 * Every branch reports back. `completed` means the underlying call said yes,
 * `rejected` means we refused it, `failed` means the call itself said no.
 */

import {
  interruptAcpFleetSession,
  rejectAcpFleetQuestion,
  respondAcpFleetPermission,
  respondAcpFleetQuestion,
  sendAcpFleetMessage,
} from "@/lib/fleet/acp-fleet-projection"
import {
  fleetFocusTerminal,
  fleetInterruptSession,
  fleetOpencodeSendMessage,
  fleetPermissionRespond,
  fleetQuestionReject,
  fleetQuestionRespond,
  fleetRevealTranscript,
} from "@/lib/tauri/fleet"
import type { ApprovalKey } from "@/lib/runtime/approval-bus"
import { ownerRoute } from "./owner"
import type {
  FleetOwnerRef,
  IslandActionIntent,
  IslandActionResult,
  IslandDecisionBehavior,
  IslandRowProjection,
  IslandState,
} from "./types"

/** Reason keys under `fleet.island.actionError.*`. */
export type IslandActionReason =
  | "staleRevision"
  | "unknownRow"
  | "notPermitted"
  | "requestChanged"
  | "noRoute"
  | "callFailed"
  | "emptyInput"
  /** The ask was answered, withdrawn or expired before this press landed. */
  | "noLongerWaiting"
  /** The turn a Stop was aimed at had already finished. */
  | "turnFinished"
  /** The execution host needs this device approved before it takes control. */
  | "hostConsent"

/**
 * The main window's authorities, injected so the validation here stays
 * testable without them. Each resolves `null` when the action happened, else
 * the reason it did not (see `main-window-controls.ts`).
 */
export interface IslandActionDeps {
  /** Select the owner context and navigate the main window. */
  navigate(path: string, owner: FleetOwnerRef): void
  /** Bring the main window forward after an owner navigation. */
  focusMainWindow?(): void | Promise<void>
  /** Clear a stale pending item. */
  dismissStale(row: IslandRowProjection): Promise<boolean>
  /** Answer a conversation's live tool approval. */
  respondToChatApproval(
    sessionId: string,
    requestId: string,
    behavior: IslandDecisionBehavior
  ): Promise<IslandActionReason | null>
  /** Approve or reject an open plan-step or budget gate. */
  decideGate(key: ApprovalKey, approve: boolean): IslandActionReason | null
  /** Approve or deny a durable run approval. */
  decideRunApproval(
    runId: string,
    interruptId: string,
    approve: boolean
  ): Promise<IslandActionReason | null>
  /** Stop a conversation's in-flight turn. */
  stopConversation(sessionId: string): Promise<IslandActionReason | null>
  /** Send a reply into a conversation. */
  replyToConversation(sessionId: string, text: string): IslandActionReason | null
}

function reject(
  intent: IslandActionIntent,
  revision: number,
  reason: IslandActionReason
): IslandActionResult {
  return { requestId: intent.requestId, revision, outcome: "rejected", reason }
}

function fail(
  intent: IslandActionIntent,
  revision: number,
  reason: IslandActionReason
): IslandActionResult {
  return { requestId: intent.requestId, revision, outcome: "failed", reason }
}

function ok(intent: IslandActionIntent, revision: number): IslandActionResult {
  return { requestId: intent.requestId, revision, outcome: "completed" }
}

/** Report an authority's answer: `null` means it happened. */
function settled(
  intent: IslandActionIntent,
  revision: number,
  reason: IslandActionReason | null
): IslandActionResult {
  return reason === null ? ok(intent, revision) : fail(intent, revision, reason)
}

/**
 * Whether this owner is controlled by the renderer-side ExternalAgentManager
 * (an ACP session) rather than the Rust fleet registry. `agentId` is stamped
 * only by the ACP fleet projection, so it is the routing marker.
 */
function acpManagedOwner(owner: FleetOwnerRef): boolean {
  return owner.kind === "external" && Boolean(owner.agentId)
}

/**
 * Validate then perform. `state` is the main window's live projection, which
 * is the only authority. `intent.revision` is what the user was looking at.
 */
export async function executeIslandAction(
  intent: IslandActionIntent,
  state: IslandState,
  deps: IslandActionDeps
): Promise<IslandActionResult> {
  const revision = state.revision
  if (intent.revision > revision) return reject(intent, revision, "staleRevision")

  const row = state.rows.find((candidate) => candidate.id === intent.rowId)
  if (!row) return reject(intent, revision, "unknownRow")

  switch (intent.kind) {
    case "open-owner": {
      if (!row.capabilities.openOwner) return reject(intent, revision, "notPermitted")
      const route = ownerRoute(row.owner)
      if (!route) return reject(intent, revision, "noRoute")
      deps.navigate(route, row.owner)
      await deps.focusMainWindow?.()
      return ok(intent, revision)
    }

    case "permission-decision": {
      if (!row.capabilities.permissionDecision || !row.permission) {
        return reject(intent, revision, "notPermitted")
      }
      if (row.permission.requestId !== intent.permissionRequestId) {
        return reject(intent, revision, "requestChanged")
      }
      if (intent.behavior === "allow_always" && !row.permission.allowAlways) {
        return reject(intent, revision, "notPermitted")
      }
      const approve = intent.behavior !== "deny"
      const owner = row.owner
      switch (owner.kind) {
        case "external": {
          const behavior = approve ? "allow" : "deny"
          const accepted = acpManagedOwner(owner)
            ? await respondAcpFleetPermission(intent.permissionRequestId, behavior)
            : await fleetPermissionRespond(intent.permissionRequestId, behavior)
          return accepted ? ok(intent, revision) : fail(intent, revision, "callFailed")
        }
        case "chat":
          return settled(
            intent,
            revision,
            await deps.respondToChatApproval(
              owner.sessionId,
              intent.permissionRequestId,
              intent.behavior
            )
          )
        case "gate":
          return settled(intent, revision, deps.decideGate(owner.gateKey, approve))
        case "run":
          return settled(
            intent,
            revision,
            await deps.decideRunApproval(owner.runId, intent.permissionRequestId, approve)
          )
        case "team":
          return reject(intent, revision, "notPermitted")
      }
    }

    case "question-response": {
      if (!row.capabilities.questionResponse) return reject(intent, revision, "notPermitted")
      if (row.question?.requestId !== intent.questionRequestId) {
        return reject(intent, revision, "requestChanged")
      }
      const accepted = acpManagedOwner(row.owner)
        ? await respondAcpFleetQuestion(intent.questionRequestId, intent.selections)
        : await fleetQuestionRespond(intent.questionRequestId, intent.selections)
      return accepted ? ok(intent, revision) : fail(intent, revision, "callFailed")
    }

    case "question-reject": {
      if (!row.capabilities.questionResponse) return reject(intent, revision, "notPermitted")
      if (row.question?.requestId !== intent.questionRequestId) {
        return reject(intent, revision, "requestChanged")
      }
      const accepted = acpManagedOwner(row.owner)
        ? await rejectAcpFleetQuestion(intent.questionRequestId)
        : await fleetQuestionReject(intent.questionRequestId)
      return accepted ? ok(intent, revision) : fail(intent, revision, "callFailed")
    }

    case "reply": {
      if (!row.capabilities.reply) return reject(intent, revision, "notPermitted")
      const text = intent.text.trim()
      if (!text) return reject(intent, revision, "emptyInput")
      if (row.owner.kind === "chat") {
        return settled(intent, revision, deps.replyToConversation(row.owner.sessionId, text))
      }
      if (row.owner.kind !== "external") return reject(intent, revision, "notPermitted")
      const accepted = row.owner.agentId
        ? await sendAcpFleetMessage(row.owner.agentId, row.owner.sessionId, text)
        : Boolean(await fleetOpencodeSendMessage(row.owner.sessionId, text))
      return accepted ? ok(intent, revision) : fail(intent, revision, "callFailed")
    }

    case "interrupt": {
      if (!row.capabilities.interrupt) return reject(intent, revision, "notPermitted")
      if (row.owner.kind === "chat") {
        return settled(intent, revision, await deps.stopConversation(row.owner.sessionId))
      }
      if (row.owner.kind !== "external") return reject(intent, revision, "notPermitted")
      const result = row.owner.agentId
        ? await interruptAcpFleetSession(row.owner.agentId, row.owner.sessionId)
        : await fleetInterruptSession(row.owner.agent, row.owner.sessionId)
      return result.ok
        ? ok(intent, revision)
        : { requestId: intent.requestId, revision, outcome: "failed", reason: result.reason }
    }

    case "focus-terminal": {
      if (!row.capabilities.focusTerminal) return reject(intent, revision, "notPermitted")
      if (row.owner.kind !== "external") return reject(intent, revision, "notPermitted")
      const focused = await fleetFocusTerminal(row.owner.agent, row.owner.sessionId)
      return focused ? ok(intent, revision) : fail(intent, revision, "callFailed")
    }

    case "open-transcript": {
      if (!row.capabilities.openTranscript) return reject(intent, revision, "notPermitted")
      if (row.owner.kind !== "external") return reject(intent, revision, "notPermitted")
      const revealed = await fleetRevealTranscript(row.owner.transcriptPath)
      return revealed ? ok(intent, revision) : fail(intent, revision, "callFailed")
    }

    case "dismiss-stale": {
      if (!row.capabilities.dismissStale) return reject(intent, revision, "notPermitted")
      const cleared = await deps.dismissStale(row)
      return cleared ? ok(intent, revision) : fail(intent, revision, "callFailed")
    }
  }
}
