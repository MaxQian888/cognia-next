import { loggers } from "@cognia/logging"
import { createDiagnostic } from "@cognia/diagnostics"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"
import type { HostStateAction } from "@cognia/agent-config-types/host-state"

/**
 * What a paired client does when the Host refuses one of its list intents.
 *
 * The conversation-list intents (`session.pin` / `folder` / `order` /
 * `workspace` / `delete` and the four `folder.*` ones) and a model pick
 * (`session.model`) are routed to the Host instead of being written
 * locally, so a refusal has two very different meanings:
 *
 * - **The Host does not know the intent at all.** A Host from before these
 *   intents existed rejects the whole submit with
 *   {@link HOST_STATE_UNSUPPORTED_SUBMIT_CODE}. On such a Host the list was
 *   never Host-authoritative — pins, folders and ranks lived on each device —
 *   so the honest fallback is exactly what this client did before routing
 *   existed: apply the write locally. Dropping it would make every
 *   organizational action silently do nothing against an older desktop. A
 *   workspace move is re-planned on this device first and is dropped if that
 *   plan refuses it (the conversation started running, the workspace went).
 * - **The Host understood and refused** (no Remote Control grant, a handoff
 *   lock, a folder that is gone). Nothing is applied locally — the Host's
 *   answer is the answer — and the one optimistic write the client made, the
 *   row of a `folder.create`, is discarded again so it does not linger as a
 *   folder only this device can see.
 *
 * Every other intent kind is left alone: its rejection is already reconciled
 * by the HostState resync the outbound queue requests.
 */
export const HOST_STATE_UNSUPPORTED_SUBMIT_CODE = "host_state_invalid_submit_request"

export async function settleRejectedHostStateIntent(
  action: HostStateAction,
  rejectionCode: string | undefined,
  outcome: "rejected" | "conflicted" = "rejected"
): Promise<void> {
  try {
    if (rejectionCode === HOST_STATE_UNSUPPORTED_SUBMIT_CODE) {
      await applyLocally(action)
      return
    }
    // Said, not swallowed: the person made this change and nothing happened.
    // A conflict is a race the resync settles, not an answer to report.
    if (outcome === "rejected" && ANNOUNCED_REFUSALS.has(action.action.kind)) {
      announceRefusal(action, rejectionCode)
    }
    if (action.action.kind === "folder.create") {
      const { discardLocalFolder } = await import("@/lib/db/session-folders")
      await discardLocalFolder(action.action.folderId)
    }
  } catch (error) {
    // Settlement runs after the receipt is recorded; a failure here (a local
    // handoff lock, a row deleted meanwhile) must not turn a settled row back
    // into a retry. The Host's refusal stands and the next sync reconciles.
    loggers.sync.warn("[host-state] settling a refused list intent failed", {
      kind: action.action.kind,
      actionId: action.actionId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * The changes a person makes to a conversation or the list, refused by the
 * Host. A refused send, steer or answer has its own surface (the chat's
 * failure banner, item 9 of the multi-user plan), and a refused new chat is
 * `hostSessionRefused`; a draft is background bookkeeping nobody asked for.
 */
const ANNOUNCED_REFUSALS: ReadonlySet<HostStateAction["action"]["kind"]> = new Set([
  "session.rename",
  "session.archive",
  "session.pin",
  "session.folder",
  "session.order",
  "session.workspace",
  "session.model",
  "session.delete",
  "folder.create",
  "folder.rename",
  "folder.reorder",
  "folder.delete",
])

function announceRefusal(action: HostStateAction, rejectionCode: string | undefined): void {
  dispatchDiagnostic(
    createDiagnostic("hostStateIntentRefused", {
      source: "chat",
      message: rejectionCode ?? "host_state_rejected",
      meta: {
        ...(action.sessionId ? { sessionId: action.sessionId } : {}),
        extra: { kind: action.action.kind, actionId: action.actionId },
      },
    })
  )
}

/** The local write each list intent stands for, as the pre-routing client made it. */
async function applyLocally(action: HostStateAction): Promise<void> {
  const intent = action.action
  const now = Date.now()
  switch (intent.kind) {
    case "folder.create": {
      // The optimistic row IS the local write; restore it only if something
      // removed it in the meantime.
      const folders = await import("@/lib/db/session-folders")
      const { getDb } = await import("@/lib/db/schema")
      if (await getDb().sessionFolders.get(intent.folderId)) return
      await folders.writeFolderCreate({
        id: intent.folderId,
        projectId: intent.projectId,
        name: intent.name,
        now,
      })
      return
    }
    case "folder.rename": {
      const { writeFolderRename } = await import("@/lib/db/session-folders")
      await writeFolderRename(intent.folderId, intent.name, now)
      return
    }
    case "folder.reorder": {
      const { writeFolderReorder } = await import("@/lib/db/session-folders")
      await writeFolderReorder(intent.projectId, intent.orderedIds, now)
      return
    }
    case "folder.delete": {
      const { writeFolderDelete } = await import("@/lib/db/session-folders")
      await writeFolderDelete(intent.folderId, now)
      return
    }
    case "session.pin": {
      if (!action.sessionId) return
      const { bulkSetSessionsPinned } = await import("@/lib/db/sessions")
      await bulkSetSessionsPinned([action.sessionId], intent.pinned)
      return
    }
    case "session.folder": {
      if (!action.sessionId) return
      const { assignSessionToFolder } = await import("@/lib/db/sessions")
      await assignSessionToFolder(action.sessionId, intent.folderId)
      return
    }
    case "session.order": {
      if (!action.sessionId) return
      const { setSessionRanks } = await import("@/lib/db/sessions")
      await setSessionRanks(
        [{ id: action.sessionId, manualOrder: intent.manualOrder }],
        intent.sectionKey
      )
      return
    }
    case "session.workspace": {
      if (!action.sessionId) return
      const { moveSessionWorkspaceLocally } =
        await import("@/lib/chat/session-workspace-move-writes")
      const result = await moveSessionWorkspaceLocally(action.sessionId, intent.projectId)
      if (result.status === "refused") {
        loggers.sync.warn("[host-state] local fallback move refused", {
          actionId: action.actionId,
          reason: result.reason,
        })
      }
      return
    }
    case "session.model": {
      if (!action.sessionId) return
      const { updateSession } = await import("@/lib/db/sessions")
      await updateSession(action.sessionId, {
        model: intent.model,
        providerOverride: intent.provider,
      })
      return
    }
    case "session.delete": {
      if (!action.sessionId) return
      const { deleteSessionsWithTeardown } = await import("@/lib/chat/session-deletion")
      await deleteSessionsWithTeardown([action.sessionId])
      return
    }
    default:
      return
  }
}
