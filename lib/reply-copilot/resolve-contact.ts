/**
 * Which contact is the copilot reading for (ADR-0194)?
 *
 * The sender of the latest "other" message, resolved through the identity
 * directory (absorbed aliases map to their surviving primary). A conversation
 * key is NOT a user id — on Slack / Discord / Lark the DM channel id differs
 * from the member id — so the chat id is only a fallback, and only for a
 * one-to-one conversation whose transcript names no sender.
 */

import { findSessionByConversationKey } from "@/lib/connectors/session-bindings"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { listRecentMessages } from "@/lib/db/messages"
import { getByPlatformUser } from "@/lib/db/platform-identities"
import type { PlatformIdentityRow } from "@/lib/db/connector-types"
import { buildCopilotTranscript, type TranscriptRow } from "@/lib/reply-copilot/build-state"
import { parseConversationKey, type PlatformIdentity } from "@/types/connectors/event"
import type { PlatformKind } from "@/types/connectors/platform-kind"

/** The adapter's own account / bot ids, so its echoed sends read as "me". */
export async function selfPlatformIdsForAdapter(adapterId: string): Promise<Set<string>> {
  const self = (await getAdapterInstance(adapterId).catch(() => undefined))?.selfIdentity
  return new Set([self?.platformAccountId, self?.platformBotId].filter((id): id is string => !!id))
}

export interface ResolveContactInput {
  sender: Pick<PlatformIdentity, "platform" | "remoteUserId"> | null
  conversationKey?: string
  isGroup: boolean
}

export interface ResolveContactDeps {
  getByPlatformUser: (
    platform: PlatformKind,
    remoteUserId: string
  ) => Promise<PlatformIdentityRow | undefined>
}

const defaultDeps: ResolveContactDeps = { getByPlatformUser }

export async function resolveCopilotContact(
  input: ResolveContactInput,
  deps: ResolveContactDeps = defaultDeps
): Promise<PlatformIdentityRow | null> {
  if (input.sender) {
    const found = await deps.getByPlatformUser(input.sender.platform, input.sender.remoteUserId)
    if (found) return found
  }
  if (input.isGroup || input.sender || !input.conversationKey) return null
  let parsed
  try {
    parsed = parseConversationKey(input.conversationKey)
  } catch {
    return null
  }
  return (await deps.getByPlatformUser(parsed.platform, parsed.remoteChatId)) ?? null
}

/** Rows scanned to find who is on the other end of a conversation. */
const CONTACT_SCAN_ROWS = 40

export interface ConversationContactDeps extends ResolveContactDeps {
  recentRows: (conversationKey: string) => Promise<TranscriptRow[]>
  selfPlatformIds: (adapterId: string) => Promise<Set<string>>
}

const defaultConversationDeps: ConversationContactDeps = {
  getByPlatformUser,
  recentRows: async (conversationKey) => {
    const session = await findSessionByConversationKey(conversationKey)
    return session
      ? ((await listRecentMessages(session.id, CONTACT_SCAN_ROWS)) as TranscriptRow[])
      : []
  },
  selfPlatformIds: selfPlatformIdsForAdapter,
}

/**
 * The one-to-one contact behind an IM conversation (the contact drawer's
 * subject). A group conversation — several distinct senders — has no single
 * contact and resolves to `null`.
 */
export async function resolveConversationContact(
  conversationKey: string,
  deps: ConversationContactDeps = defaultConversationDeps
): Promise<PlatformIdentityRow | null> {
  let adapterId: string | null = null
  try {
    adapterId = parseConversationKey(conversationKey).adapterId
  } catch {
    return null
  }
  const [rows, selfIds] = await Promise.all([
    deps.recentRows(conversationKey),
    deps.selfPlatformIds(adapterId),
  ])
  const transcript = buildCopilotTranscript(rows, selfIds)
  if (transcript.isGroup) return null
  return resolveCopilotContact(
    { sender: transcript.latestOtherSender, conversationKey, isGroup: false },
    deps
  )
}
