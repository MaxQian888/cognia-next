/**
 * Lark chat-management implementation (W2 multi-bot) — the first adapter
 * behind the platform-neutral `PlatformAdapter` chat-management surface.
 *
 * All member ids are Lark `open_id`s. Every method maps permission failures
 * through `classifyScopeError` so callers receive a typed
 * `ChatManagementScopeError` naming the console scope to enable:
 *   - createChat        → `im:chat:create` (umbrella `im:chat`)
 *   - add/removeMembers → `im:chat.members:write_only`
 *   - updateChat        → `im:chat:update`
 *   - resolveContacts   → `contact:user.id:readonly` (email/phone batch);
 *                         name search additionally needs a CONNECTED USER
 *                         token (`search/v1/user` rejects bot identities).
 */

import type {
  ChatMembersInput,
  ChatMembersResult,
  ContactCandidate,
  CreateChatInput,
  CreateChatResult,
  ResolveContactsInput,
  UpdateChatInput,
} from "@/types/connectors/chat-management"
import { classifyScopeError, larkTenantRequest, larkUserRequest } from "./http"
import type { LarkCredentials } from "./http"

export interface LarkChatManagement {
  createChat(input: CreateChatInput): Promise<CreateChatResult>
  addChatMembers(input: ChatMembersInput): Promise<ChatMembersResult>
  removeChatMembers(input: ChatMembersInput): Promise<ChatMembersResult>
  updateChat(input: UpdateChatInput): Promise<void>
  resolveContacts(input: ResolveContactsInput): Promise<ContactCandidate[]>
}

async function tenantCall(
  resolveCreds: () => Promise<LarkCredentials>,
  requiredScope: string,
  method: Parameters<typeof larkTenantRequest>[1],
  urlPath: string,
  body?: unknown
): Promise<unknown> {
  const creds = await resolveCreds()
  try {
    return await larkTenantRequest(creds, method, urlPath, body)
  } catch (err) {
    throw classifyScopeError(err, requiredScope) ?? err
  }
}

function membersResult(memberIds: string[], invalid: string[]): ChatMembersResult {
  const invalidSet = new Set(invalid)
  return {
    succeeded: memberIds.filter((id) => !invalidSet.has(id)),
    failed: invalid.map((id) => ({ id, reason: "invalid_member_id" })),
  }
}

/**
 * Build the five `PlatformAdapter` chat-management methods for one Lark
 * adapter instance. `adapterId` keys the optional user-token path (name
 * search); `resolveCreds` is the same credential thunk the factory uses.
 */
export function createLarkChatManagement(
  adapterId: string,
  resolveCreds: () => Promise<LarkCredentials>
): LarkChatManagement {
  return {
    async createChat(input: CreateChatInput): Promise<CreateChatResult> {
      const qs = new URLSearchParams({ set_bot_manager: "true", user_id_type: "open_id" })
      // Platform-side idempotency: Lark dedups creates sharing a uuid.
      if (input.idempotencyKey) qs.set("uuid", input.idempotencyKey)
      const parsed = (await tenantCall(
        resolveCreds,
        "im:chat:create",
        "POST",
        `/im/v1/chats?${qs.toString()}`,
        {
          name: input.name,
          ...(input.description ? { description: input.description } : {}),
          user_id_list: input.memberIds,
        }
      )) as {
        data?: { chat_id?: string; invalid_user_id_list?: string[]; invalid_id_list?: string[] }
      } | null
      const chatId = parsed?.data?.chat_id
      if (!chatId) {
        throw new Error("Lark create-chat returned no chat_id — response shape drift?")
      }
      const invalid = parsed?.data?.invalid_user_id_list ?? parsed?.data?.invalid_id_list ?? []
      return { chatId, ...(invalid.length > 0 ? { invalidMemberIds: invalid } : {}) }
    },

    async addChatMembers(input: ChatMembersInput): Promise<ChatMembersResult> {
      // succeed_type=1: partial success — reachable ids are added, the rest
      // come back in `invalid_id_list` instead of failing the whole call.
      const parsed = (await tenantCall(
        resolveCreds,
        "im:chat.members:write_only",
        "POST",
        `/im/v1/chats/${encodeURIComponent(input.chatId)}/members?member_id_type=open_id&succeed_type=1`,
        { id_list: input.memberIds }
      )) as { data?: { invalid_id_list?: string[] } } | null
      return membersResult(input.memberIds, parsed?.data?.invalid_id_list ?? [])
    },

    async removeChatMembers(input: ChatMembersInput): Promise<ChatMembersResult> {
      const parsed = (await tenantCall(
        resolveCreds,
        "im:chat.members:write_only",
        "DELETE",
        `/im/v1/chats/${encodeURIComponent(input.chatId)}/members?member_id_type=open_id`,
        { id_list: input.memberIds }
      )) as { data?: { invalid_id_list?: string[] } } | null
      return membersResult(input.memberIds, parsed?.data?.invalid_id_list ?? [])
    },

    async updateChat(input: UpdateChatInput): Promise<void> {
      await tenantCall(
        resolveCreds,
        "im:chat:update",
        "PUT",
        `/im/v1/chats/${encodeURIComponent(input.chatId)}?user_id_type=open_id`,
        {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        }
      )
    },

    async resolveContacts(input: ResolveContactsInput): Promise<ContactCandidate[]> {
      const out: ContactCandidate[] = []
      const emails = input.emails ?? []
      const phones = input.phones ?? []

      if (emails.length > 0 || phones.length > 0) {
        const parsed = (await tenantCall(
          resolveCreds,
          "contact:user.id:readonly",
          "POST",
          "/contact/v3/users/batch_get_id?user_id_type=open_id",
          {
            ...(emails.length > 0 ? { emails } : {}),
            ...(phones.length > 0 ? { mobiles: phones } : {}),
          }
        )) as {
          data?: { user_list?: Array<{ user_id?: string; email?: string; mobile?: string }> }
        } | null
        for (const u of parsed?.data?.user_list ?? []) {
          // Entries without user_id are "not found" markers — skip them.
          if (!u.user_id) continue
          out.push({
            memberId: u.user_id,
            ...(u.email ? { email: u.email } : {}),
            ...(u.mobile ? { phone: u.mobile } : {}),
            confidence: "exact",
          })
        }
      }

      const query = input.query?.trim()
      if (query) {
        const creds = await resolveCreds()
        let parsed: unknown | null
        try {
          // `GET /search/v1/user` (scope `search:user`) only accepts USER
          // access tokens — Lark bots cannot search the directory by display
          // name. (Newer tenants may prefer `directory/v1` employee search;
          // this v1 endpoint remains the broadly-available user-token one.)
          parsed = await larkUserRequest(
            adapterId,
            creds,
            "GET",
            `/search/v1/user?query=${encodeURIComponent(query)}&page_size=20`
          )
        } catch (err) {
          throw classifyScopeError(err, "search:user") ?? err
        }
        if (parsed === null) {
          throw new Error(
            "Name search needs a connected user identity on this Lark bot — connect user OAuth in Settings → Connections, or provide an email/phone instead."
          )
        }
        const users =
          (parsed as { data?: { users?: Array<{ open_id?: string; name?: string }> } })?.data
            ?.users ?? []
        for (const u of users) {
          if (!u.open_id) continue
          out.push({
            memberId: u.open_id,
            ...(u.name ? { displayName: u.name } : {}),
            confidence: "fuzzy",
          })
        }
      }

      return out
    },
  }
}
