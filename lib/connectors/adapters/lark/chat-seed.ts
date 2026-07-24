/**
 * Chat-surface seeding (plan 2026-07-24 P4.1/P4.3).
 *
 * `ensureChatSurface` was only ever reached from a live
 * `im.chat.member.bot.added_v1` event, and both the start-up sweep and the
 * settings resync only process rows that ALREADY exist. So enabling Chat Tab
 * or the group menu did nothing for any chat the bot was already in — the
 * operator had to remove and re-add the bot in every conversation.
 *
 * This module closes that hole by enumerating the bot's chats
 * (`GET /im/v1/chats`, scope `im:chat:readonly`) and creating the desired-state
 * rows the sweep then reconciles. `chat_mode` is authoritative for surface
 * eligibility: `menu_tree` is group-only, so p2p chats never get a group-menu
 * row rather than getting one that is refused forever.
 */

import { isLarkFeatureEnabled } from "@/lib/connectors/feature-flags"
import { CHAT_TAB_URL_VERSION } from "@/lib/connectors/entry/deep-links"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { ensureChatSurface } from "@/lib/db/lark-chat-surfaces"
import { larkTenantRequest, type LarkCredentials } from "./http"
import { resolveSurfaceIdentity } from "./chat-tabs"

export const CHAT_LIST_SCOPE = "im:chat:readonly"

const PAGE_SIZE = 100
/** Bounded like the member-list scan: 50 × 100 chats is far past any tenant. */
const PAGE_LIMIT = 50

export interface LarkChatListItem {
  chat_id?: string
  /** "p2p" | "group" | "topic" — group menus require a group. */
  chat_mode?: string
}

export interface ChatSeedDependencies {
  request: typeof larkTenantRequest
  getAdapter: typeof getAdapterInstance
  ensure: typeof ensureChatSurface
  now: () => number
}

function withDefaults(overrides: Partial<ChatSeedDependencies>): ChatSeedDependencies {
  return {
    request: larkTenantRequest,
    getAdapter: getAdapterInstance,
    ensure: ensureChatSurface,
    now: Date.now,
    ...overrides,
  }
}

/** Page through every chat this bot belongs to. */
export async function listBotChats(
  deps: ChatSeedDependencies,
  creds: LarkCredentials
): Promise<LarkChatListItem[]> {
  const chats: LarkChatListItem[] = []
  let pageToken: string | undefined
  for (let page = 0; page < PAGE_LIMIT; page += 1) {
    const query = new URLSearchParams({
      page_size: String(PAGE_SIZE),
      ...(pageToken ? { page_token: pageToken } : {}),
    })
    const parsed = (await deps.request(creds, "GET", `/im/v1/chats?${query.toString()}`)) as {
      data?: { items?: LarkChatListItem[]; has_more?: boolean; page_token?: string }
    } | null
    chats.push(...(parsed?.data?.items ?? []))
    if (!parsed?.data?.has_more || !parsed.data.page_token) break
    pageToken = parsed.data.page_token
  }
  return chats
}

export interface SeedChatSurfacesResult {
  chats: number
  seeded: number
}

export interface SeedChatSurfacesInput {
  adapterId: string
  resolveCreds: () => Promise<LarkCredentials>
}

/**
 * Create the desired-state rows for every eligible chat. Idempotent by
 * construction: `ensureChatSurface` is keyed on (adapterId, chatId,
 * surfaceType), so re-seeding converges on the same rows and never re-arms a
 * `synced` or `blocked` one whose target is unchanged.
 */
export async function seedLarkChatSurfaces(
  input: SeedChatSurfacesInput,
  overrides: Partial<ChatSeedDependencies> = {}
): Promise<SeedChatSurfacesResult> {
  const deps = withDefaults(overrides)
  const adapterRow = await deps.getAdapter(input.adapterId).catch(() => undefined)
  const tabsOn = isLarkFeatureEnabled("larkChatTab", adapterRow)
  const menusOn = isLarkFeatureEnabled("larkGroupMenu", adapterRow)
  if (!tabsOn && !menusOn) return { chats: 0, seeded: 0 }

  // Without a verified tenant/app the surface URL cannot be minted; the
  // reconciler would only park every row as `identity_unknown`.
  const identity = resolveSurfaceIdentity(adapterRow, {})
  if (!identity) return { chats: 0, seeded: 0 }

  const creds = await input.resolveCreds()
  const chats = await listBotChats(deps, creds)
  let seeded = 0
  for (const chat of chats) {
    if (!chat.chat_id) continue
    const isGroup = chat.chat_mode !== "p2p"
    const surfaces: Array<"chat_tab" | "group_menu"> = []
    if (tabsOn) surfaces.push("chat_tab")
    if (menusOn && isGroup) surfaces.push("group_menu")
    for (const surfaceType of surfaces) {
      await deps.ensure({
        adapterId: input.adapterId,
        chatId: chat.chat_id,
        surfaceType,
        urlVersion: CHAT_TAB_URL_VERSION,
        tenantKey: identity.tenantKey,
        appId: identity.appId,
        now: deps.now(),
      })
      seeded += 1
    }
  }
  return { chats: chats.length, seeded }
}
