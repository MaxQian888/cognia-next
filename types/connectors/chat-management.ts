/**
 * Platform-neutral chat-management shapes (W2 multi-bot).
 *
 * These are the inputs/outputs of the OPTIONAL `PlatformAdapter` methods
 * `createChat` / `addChatMembers` / `removeChatMembers` / `updateChat` /
 * `resolveContacts`. Every field is platform-agnostic — member ids are the
 * platform's canonical user ids (Lark `open_id`, Telegram user id, …) as
 * returned by `resolveContacts` on the SAME adapter instance. Adapters that
 * implement a method declare the paired capability flag (`chat.create`,
 * `chat.members`, `chat.update`, `contact.resolve`); the `im.*` built-in
 * skills are gated on those flags and never reach an incapable platform.
 */

import type { PlatformKind } from "./platform-kind"

export interface CreateChatInput {
  /** Display name for the new chat. */
  name: string
  /** Canonical platform member ids to invite at creation time. */
  memberIds: string[]
  description?: string
  /**
   * Caller-supplied idempotency token. Adapters forward it to the platform
   * when the API supports server-side dedup (Lark `uuid` query param) so a
   * retried create doesn't mint a second chat.
   */
  idempotencyKey?: string
}

export interface CreateChatResult {
  /** Platform chat id of the new chat (Lark `oc_…`). */
  chatId: string
  /**
   * Member ids the platform rejected (unknown, not visible to the app, …).
   * The chat itself was still created; callers surface these so the model
   * can report partial failures instead of claiming full success.
   */
  invalidMemberIds?: string[]
}

export interface ChatMembersInput {
  chatId: string
  memberIds: string[]
}

export interface ChatMembersResult {
  succeeded: string[]
  failed: Array<{ id: string; reason?: string }>
}

export interface UpdateChatInput {
  chatId: string
  /** New chat display name. */
  name?: string
  /** New chat description (rendered in the chat profile). */
  description?: string
  // Extensible: group announcement is a documented follow-up (Lark's modern
  // announcement is a docx-backed CCM document, out of scope for v1).
}

export interface ResolveContactsInput {
  /** Exact-match lookups (batch): emails and/or phone numbers. */
  emails?: string[]
  phones?: string[]
  /**
   * Free-text name search. Platform-dependent: on Lark it requires a
   * connected USER OAuth token (bot identities cannot search by name);
   * adapters throw an actionable error when the prerequisite is missing.
   */
  query?: string
}

export interface ContactCandidate {
  /** Canonical platform member id (feeds `memberIds` of the write methods). */
  memberId: string
  displayName?: string
  email?: string
  phone?: string
  /** Exact for email/phone batch lookups; fuzzy for name search hits. */
  confidence: "exact" | "fuzzy"
}

/**
 * Typed error for "the platform rejected the call because the app is missing
 * a permission scope". Skills catch it to (a) persist the missing scope onto
 * `AdapterInstanceRow.lastMissingScopes` for the whoami panel, and (b) return
 * an actionable message telling the operator which console permission to
 * enable.
 */
export class ChatManagementScopeError extends Error {
  constructor(
    message: string,
    readonly requiredScope: string,
    readonly platform: PlatformKind
  ) {
    super(message)
    this.name = "ChatManagementScopeError"
  }
}
