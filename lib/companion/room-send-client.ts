/**
 * Companion side of `room_send` / `room_stop` (ADR-0177).
 *
 * A paired phone or web companion never orchestrates a team room. It asks
 * the host to, over the routing transport, and renders the member events the
 * host's sidecar streams back. Both commands are `target: execution` arms
 * bridged to the host's `lib/companion/desktop-write-source.ts`.
 *
 * `room_send` returns as soon as the host accepted the turn. A team turn can
 * run for minutes, far past the bridge's 30s request timeout, so the host
 * runs it detached and the companion learns the outcome from the events.
 */

import { transport } from "@/lib/tauri"
import type { MessageReplyTo, SendContent, SendOptions } from "@cognia/agent-config-types"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"

export const ROOM_SEND_COMMAND = "room_send"
export const ROOM_STOP_COMMAND = "room_stop"

export interface RoomSendRequest {
  sessionId: string
  /** Absent for `regenerate`, whose content the host already holds. */
  content?: SendContent
  webSearchContext?: SendOptions["webSearchContext"]
  attachmentManifest?: readonly AttachmentManifestEntry[]
  /** Re-issue the room's last user turn instead of sending `content`. */
  regenerate?: boolean
  /** Replace this user message with `content` and re-run the turn below it. */
  editMessageId?: string
  /** The message this turn answers (ADR-0177 batch 2), stamped on the user row by the host. */
  replyTo?: MessageReplyTo
}

export interface RoomSendResponse {
  accepted: boolean
}

export async function sendRoomTurn(request: RoomSendRequest): Promise<RoomSendResponse> {
  const result = await transport.call<RoomSendResponse | null>(ROOM_SEND_COMMAND, {
    ...request,
    ...(request.attachmentManifest ? { attachmentManifest: [...request.attachmentManifest] } : {}),
  })
  return result ?? { accepted: false }
}

export async function stopRoomTurn(sessionId: string): Promise<void> {
  await transport.call<null>(ROOM_STOP_COMMAND, { sessionId })
}
