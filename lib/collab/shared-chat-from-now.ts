/**
 * Share a private conversation from now on (ADR-0241).
 *
 * The private conversation and its history stay where they are: nothing of
 * them is uploaded. A new, empty shared session is created and becomes the
 * place the conversation continues with others. The only thing that crosses is
 * the background the owner chose to write (usually an edited draft from the
 * summarize-then-branch summary), posted as the owner's first message so
 * every executor rebuilds the same context from the shared log.
 *
 * The shared session's local projection records the private conversation as
 * its `parentSessionId`, so the existing branch lineage chips link the two.
 * That link lives only on this device: other members never learn the private
 * conversation exists.
 */

import type { ChatSession, SharedSession } from "@cognia/agent-config-types"
import { sha256Hex } from "@/lib/data/crypto"
import { getDb } from "@/lib/db/schema"
import type { CollabClient } from "./client"
import { SharedChatTeamSessionUnsupportedError } from "./shared-chat-conversion"
import { assertSharedChatClientEnabled } from "./shared-chat-feature"
import { syncSharedSession } from "./shared-chat-sync"

type ShareFromNowClient = { readonly baseUrl?: string } & Pick<
  CollabClient,
  | "createSharedSession"
  | "appendSessionEvent"
  | "getSharedSession"
  | "listSessionMembers"
  | "listSessionEvents"
>

export interface ShareFromNowInput {
  localSessionId: string
  orgId: string
  workspaceId: string
  /**
   * Identifies one share attempt. A retry after a lost response passes the same
   * id, so the server replays the same session instead of creating another.
   */
  attemptId: string
  /** The owner-confirmed background, already prefixed with its heading. Empty posts nothing. */
  background?: string
}

export interface ShareFromNowResult {
  session: SharedSession
  /** The shared session's local projection, to open next. */
  localSessionId: string
}

async function readPrivateSource(localSessionId: string): Promise<ChatSession> {
  const session = await getDb().sessions.get(localSessionId)
  if (!session) throw new Error(`Local session ${localSessionId} does not exist`)
  if (session.collaboration) throw new Error("Session is already shared")
  if (session.kind === "team") throw new SharedChatTeamSessionUnsupportedError()
  return session
}

export async function shareConversationFromNow(
  client: ShareFromNowClient,
  input: ShareFromNowInput
): Promise<ShareFromNowResult> {
  assertSharedChatClientEnabled()
  const db = getDb()
  const source = await readPrivateSource(input.localSessionId)
  const prefix = `chat-share-from-now:${source.id}:${input.attemptId}`
  const created = await client.createSharedSession(input.orgId, input.workspaceId, {
    title: source.title,
    importing: false,
    operationId: `${prefix}:create`,
  })
  if (getDb() !== db) throw new DOMException("Shared conversation cancelled", "AbortError")
  if (created.status !== "active")
    throw new Error("The server did not open the shared conversation")

  const background = input.background?.trim()
  if (background) {
    // Content-addressed, and timed by the server (no `createdAt`): a retry
    // after a lost response replays the same payload instead of conflicting,
    // and a background edited before the retry is a new message, not a clash.
    const id = `${prefix}:background:${await sha256Hex(background)}`
    await client.appendSessionEvent(input.orgId, created.id, {
      kind: "message.created",
      operationId: id,
      payload: { messageId: id, role: "user", parts: [{ type: "text", text: background }] },
    })
    if (getDb() !== db) throw new DOMException("Shared conversation cancelled", "AbortError")
  }

  const synced = await syncSharedSession(client, input.orgId, created.id)
  if (getDb() !== db) throw new DOMException("Shared conversation cancelled", "AbortError")
  await db.sessions.update(synced.localSessionId, { parentSessionId: source.id })
  return { session: synced.session, localSessionId: synced.localSessionId }
}
