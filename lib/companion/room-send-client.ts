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

import type { ChatTemplateRun } from "@/lib/chat/template/run"
import { transport } from "@/lib/tauri"
import type { MessageReplyTo, SendContent, SendOptions } from "@cognia/agent-config-types"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import type { ContextRef } from "@/lib/chat/mentions/types"
import type { PromptPreambleSummary } from "@/lib/chat/prompt-preamble"

export const ROOM_SEND_COMMAND = "room_send"
export const ROOM_STOP_COMMAND = "room_stop"

export interface RoomSendRequest {
  sessionId: string
  /** Absent for `regenerate`, whose content the host already holds. */
  content?: SendContent
  webSearchContext?: SendOptions["webSearchContext"]
  attachmentManifest?: readonly AttachmentManifestEntry[]
  /** Template provenance retained only on the user transcript row. */
  templateRun?: ChatTemplateRun
  /** Re-issue the room's last user turn instead of sending `content`. */
  regenerate?: boolean
  /** Replace this user message with `content` and re-run the turn below it. */
  editMessageId?: string
  /** The message this turn answers (ADR-0177 batch 2), stamped on the user row by the host. */
  replyTo?: MessageReplyTo
  /** The members the composer picked to answer (ADR-0177 batch 3), in pick order. */
  targetMemberIds?: string[]
  /**
   * The records this turn cites (ADR-0157): the sent context chips plus the
   * typed `@…` tokens. The envelope inside `content` carries the snapshot to
   * the model, but only this field lets the persisted row keep its citations —
   * without it the host's user row gets no `metadata.mentions` and no
   * backlink.
   */
  citations?: readonly ContextRef[]
  /** What the context envelope in `content` carries — sections and reference names, never bodies. */
  promptPreamble?: PromptPreambleSummary
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

/**
 * Stop the room, or with `characterId` (ADR-0177 batch 3) one member of it
 * while the rest of the round goes on.
 */
export async function stopRoomTurn(sessionId: string, characterId?: string): Promise<void> {
  await transport.call<null>(ROOM_STOP_COMMAND, {
    sessionId,
    ...(characterId ? { characterId } : {}),
  })
}
