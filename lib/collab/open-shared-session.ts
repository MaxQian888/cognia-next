/**
 * What happens once a shared-chat invite has been accepted, whichever way it
 * was accepted: a pasted token (`components/chat/shared-session-join.tsx`) or
 * a targeted invite opened from its notification
 * (`components/chat/targeted-invite-accept.tsx`, ADR-0207).
 *
 * The membership the accept returned is not enough to render the
 * conversation: it has to be pulled into the local mirror first, which is
 * what produces the local session id. Then the conversation is opened the same
 * way a click in the sidebar opens it: its workspace becomes the active
 * project, it becomes the active session, and the shell goes to the DM guild.
 *
 * Kept free of toasts and translations on purpose: the two callers word their
 * outcome differently and own their own error reporting.
 */

import { syncSharedSession, type SharedChatSyncResult } from "@/lib/collab/shared-chat-sync"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"

export interface OpenAcceptedSharedSessionInput {
  client: Parameters<typeof syncSharedSession>[0]
  orgId: string
  /** The shared (server) session id the accepted invite names. */
  sharedSessionId: string
  /** `useShellNav().switchToDm`, so the conversation is on screen. */
  switchToDm: () => void
}

export async function openAcceptedSharedSession(
  input: OpenAcceptedSharedSessionInput
): Promise<SharedChatSyncResult> {
  const synced = await syncSharedSession(input.client, input.orgId, input.sharedSessionId)
  useProjectStore.getState().setActiveProject(synced.session.workspaceId)
  useChatStore.getState().setActiveSession(synced.localSessionId)
  input.switchToDm()
  return synced
}
