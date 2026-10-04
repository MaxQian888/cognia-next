/**
 * Pure selection helpers behind Settings → Agent Runtime → Sessions.
 *
 * The tab is a runtime view of conversations, not a second conversation
 * manager (ADR-0213): it counts what the Conversations page manages, lists the
 * conversations that resume a native Claude Agent SDK session, and joins
 * native SDK sessions back to the Cognia chats bound to them. Every rule that
 * decides which rows count lives here so the components only render.
 *
 * Exposure follows `lib/chat/session-exposure.ts` on the `main-list` channel:
 * embedded sessions (subagent transcripts, workflow-editor and resource
 * workbench chats) are not conversations the user can open from a list, so
 * they are neither counted nor listed.
 */

import { conversationLastActivityAt } from "@/lib/chat/conversation-list-model"
import type { ChatSession } from "@cognia/agent-config-types"

import { filterExposedSessions } from "@/lib/chat/session-exposure"

/** Active vs archived conversations, as the Conversations page tabs split them. */
export interface ConversationCounts {
  active: number
  archived: number
}

/** Count the exposed conversations on each side of the archive. */
export function countExposedConversations(
  sessions: readonly Pick<ChatSession, "kind" | "visibility" | "archivedAt">[]
): ConversationCounts {
  let active = 0
  let archived = 0
  for (const session of filterExposedSessions(sessions, "main-list")) {
    if (session.archivedAt == null) active += 1
    else archived += 1
  }
  return { active, archived }
}

/** When the conversation last moved — the list model's one definition. */
export { conversationLastActivityAt as sessionLastActivity }

function byLastActivityDesc(a: ChatSession, b: ChatSession): number {
  return conversationLastActivityAt(b) - conversationLastActivityAt(a) || a.id.localeCompare(b.id)
}

/**
 * Exposed conversations that carry an SDK session id, newest activity first.
 * Archived rows stay in: an archived conversation still resumes its SDK
 * session when it is reopened, so it is part of the runtime picture.
 */
export function selectSdkBoundConversations(sessions: readonly ChatSession[]): ChatSession[] {
  return filterExposedSessions(sessions, "main-list")
    .filter((session) => typeof session.sdkSessionId === "string" && session.sdkSessionId !== "")
    .sort(byLastActivityDesc)
}

/**
 * Case-insensitive match on the displayed title, the conversation id and the
 * SDK session id. An empty query keeps every row.
 */
export function filterSdkBoundConversations(
  sessions: readonly ChatSession[],
  query: string,
  titleOf: (session: ChatSession) => string
): ChatSession[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...sessions]
  return sessions.filter((session) =>
    [titleOf(session), session.id, session.sdkSessionId ?? ""].some((field) =>
      field.toLowerCase().includes(needle)
    )
  )
}

/** Where a native SDK session listed by the SDK manager is stored. */
export interface SdkSessionLocator {
  sessionId: string
  storage?: "filesystem" | "host-sqlite"
  /** The SessionStore scope a `host-sqlite` row was listed under. */
  storageWorkspace?: string
}

/**
 * Whether `chat` resumes the native session `row` names.
 *
 * The id alone is not enough once a transcript has been imported into the
 * host SessionStore: the filesystem original and the store copy share an id,
 * and a chat recorded against the store copy must not be treated as bound to
 * the file (deleting the file leaves that chat's transcript intact). A chat
 * with no recorded storage predates the field and resumed from whatever the
 * SDK found, so it links to every copy.
 */
export function chatLinksToSdkSession(
  chat: Pick<ChatSession, "sdkSessionId" | "sdkSessionStorage">,
  row: SdkSessionLocator
): boolean {
  if (!chat.sdkSessionId || chat.sdkSessionId !== row.sessionId) return false
  const storage = chat.sdkSessionStorage
  if (!storage) return true
  if (storage.backend !== (row.storage ?? "filesystem")) return false
  if (storage.backend === "filesystem") return true
  return (storage.workspace ?? null) === (row.storageWorkspace ?? null)
}

/** Every chat bound to `row`, newest activity first. Embedded chats included. */
export function linkedChatsFor(
  chats: readonly ChatSession[],
  row: SdkSessionLocator
): ChatSession[] {
  return chats.filter((chat) => chatLinksToSdkSession(chat, row)).sort(byLastActivityDesc)
}
