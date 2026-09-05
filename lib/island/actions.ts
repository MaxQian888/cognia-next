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
  fleetFocusTerminal,
  fleetInterruptSession,
  fleetOpencodeSendMessage,
  fleetPermissionRespond,
  fleetQuestionReject,
  fleetQuestionRespond,
  fleetRevealTranscript,
} from "@/lib/tauri/fleet"
import { ownerRoute } from "./owner"
import type {
  IslandActionIntent,
  IslandActionResult,
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

export interface IslandActionDeps {
  /** Navigate the main window. Supplied by the initializer's router. */
  navigate(path: string): void
  /** Bring the main window forward after an owner navigation. */
  focusMainWindow?(): void | Promise<void>
  /** Clear a stale pending item. Supplied by the initializer. */
  dismissStale(row: IslandRowProjection): Promise<boolean>
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
      deps.navigate(route)
      await deps.focusMainWindow?.()
      return ok(intent, revision)
    }

    case "permission-decision": {
      if (!row.capabilities.permissionDecision) return reject(intent, revision, "notPermitted")
      if (row.permission?.requestId !== intent.permissionRequestId) {
        return reject(intent, revision, "requestChanged")
      }
      const accepted = await fleetPermissionRespond(intent.permissionRequestId, intent.behavior)
      return accepted ? ok(intent, revision) : fail(intent, revision, "callFailed")
    }

    case "question-response": {
      if (!row.capabilities.questionResponse) return reject(intent, revision, "notPermitted")
      if (row.question?.requestId !== intent.questionRequestId) {
        return reject(intent, revision, "requestChanged")
      }
      const accepted = await fleetQuestionRespond(intent.questionRequestId, intent.selections)
      return accepted ? ok(intent, revision) : fail(intent, revision, "callFailed")
    }

    case "question-reject": {
      if (!row.capabilities.questionResponse) return reject(intent, revision, "notPermitted")
      if (row.question?.requestId !== intent.questionRequestId) {
        return reject(intent, revision, "requestChanged")
      }
      const accepted = await fleetQuestionReject(intent.questionRequestId)
      return accepted ? ok(intent, revision) : fail(intent, revision, "callFailed")
    }

    case "reply": {
      if (!row.capabilities.reply) return reject(intent, revision, "notPermitted")
      const text = intent.text.trim()
      if (!text) return reject(intent, revision, "emptyInput")
      if (row.owner.kind !== "external") return reject(intent, revision, "notPermitted")
      const messageId = await fleetOpencodeSendMessage(row.owner.sessionId, text)
      return messageId ? ok(intent, revision) : fail(intent, revision, "callFailed")
    }

    case "interrupt": {
      if (!row.capabilities.interrupt) return reject(intent, revision, "notPermitted")
      if (row.owner.kind !== "external") return reject(intent, revision, "notPermitted")
      const result = await fleetInterruptSession(row.owner.agent, row.owner.sessionId)
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
