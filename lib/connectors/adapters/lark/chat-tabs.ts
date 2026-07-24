/**
 * Lark Chat Tab reconciler (plan 2026-07-24 P4.1).
 *
 * Keeps one "Cognia" url-type tab per chat pointed at the authorized surface
 * URL (`buildSurfaceUrl` — an integrity-only descriptor; authorization
 * happens at resolve time via web SSO + membership check). Desired state
 * lives in Dexie `larkChatSurfaces` (status machine + backoff, see
 * `lib/db/lark-chat-surfaces.ts`); this module drives the platform side.
 *
 * API contract pinned against open.feishu.cn (server-docs/group/chat-tab,
 * 2026-07): create `POST /im/v1/chats/{id}/chat_tabs`, list
 * `GET …/chat_tabs/list_tabs`, update `POST …/chat_tabs/update_tabs`
 * (tab_id + full shape, url/doc types only), delete
 * `DELETE …/chat_tabs/delete_tabs` ({tab_ids}). Write scope
 * `im:chat.tabs:write_only`; ≤20 custom tabs; the bot must be IN the chat
 * (p2p and group both supported). List-before-write keeps re-runs
 * idempotent even when the stored tab_id was lost.
 */

import { isLarkFeatureEnabled } from "@/lib/connectors/feature-flags"
import { appendAudit } from "@/lib/connectors/audit"
import { buildSurfaceUrl, CHAT_TAB_URL_VERSION } from "@/lib/connectors/entry/deep-links"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow, LarkChatSurfaceType } from "@/lib/db/connector-types"
import {
  ensureChatSurface,
  getChatSurface,
  markChatSurfaceError,
  markChatSurfaceSynced,
} from "@/lib/db/lark-chat-surfaces"
import { classifyScopeError, larkTenantRequest, type LarkCredentials } from "./http"

export const COGNIA_TAB_NAME = "Cognia"
export const CHAT_TAB_WRITE_SCOPE = "im:chat.tabs:write_only"

export interface SurfaceReconcileContext {
  adapterId: string
  resolveCreds: () => Promise<LarkCredentials>
}

export interface SurfaceReconcileDependencies {
  request: typeof larkTenantRequest
  getAdapter: typeof getAdapterInstance
  ensure: typeof ensureChatSurface
  markSynced: typeof markChatSurfaceSynced
  markError: typeof markChatSurfaceError
  audit: typeof appendAudit
  buildUrl: typeof buildSurfaceUrl
  now: () => number
}

export function withSurfaceDefaults(
  overrides: Partial<SurfaceReconcileDependencies>
): SurfaceReconcileDependencies {
  return {
    request: larkTenantRequest,
    getAdapter: getAdapterInstance,
    ensure: ensureChatSurface,
    markSynced: markChatSurfaceSynced,
    markError: markChatSurfaceError,
    audit: appendAudit,
    buildUrl: buildSurfaceUrl,
    now: Date.now,
    ...overrides,
  }
}

/**
 * The bot's tenant/app identity for surface-token minting. tenant_key is
 * only learnable from inbound traffic (`tenant-key-backfill.ts`), so a
 * fresh adapter may legitimately not know it yet — reconciles fail closed
 * until the first real event lands.
 */
export function resolveSurfaceIdentity(
  adapterRow: AdapterInstanceRow | undefined,
  stored: { tenantKey?: string; appId?: string }
): { tenantKey: string; appId: string } | null {
  const tenantKey = stored.tenantKey ?? adapterRow?.lastWhoamiResult?.tenantKey
  const appId = stored.appId ?? adapterRow?.lastWhoamiResult?.appId
  if (!tenantKey || !appId) return null
  return { tenantKey, appId }
}

/** Per-surface in-flight lock — concurrent triggers coalesce onto one run. */
const inFlight = new Map<string, Promise<SurfaceReconcileResult>>()

export function runSurfaceLocked(
  adapterId: string,
  chatId: string,
  surfaceType: LarkChatSurfaceType,
  run: () => Promise<SurfaceReconcileResult>
): Promise<SurfaceReconcileResult> {
  const key = `${adapterId}:${chatId}:${surfaceType}`
  const existing = inFlight.get(key)
  if (existing) return existing
  const promise = run().finally(() => inFlight.delete(key))
  inFlight.set(key, promise)
  return promise
}

export type SurfaceReconcileResult = "synced" | "skipped" | "error"

interface LarkChatTabRecord {
  tab_id?: string
  tab_name?: string
  tab_type?: string
  tab_content?: { url?: string }
}

async function listChatTabs(
  deps: SurfaceReconcileDependencies,
  creds: LarkCredentials,
  chatId: string
): Promise<LarkChatTabRecord[]> {
  const parsed = (await deps.request(
    creds,
    "GET",
    `/im/v1/chats/${encodeURIComponent(chatId)}/chat_tabs/list_tabs`
  )) as { data?: { chat_tabs?: LarkChatTabRecord[] } } | null
  return parsed?.data?.chat_tabs ?? []
}

/**
 * Reconcile the Cognia Chat Tab for one chat. Terminal states are recorded
 * on the Dexie row (synced / error + backoff) and audited; the return value
 * is for callers that chain (sweep, tests).
 */
export async function reconcileChatTabSurface(
  ctx: SurfaceReconcileContext,
  chatId: string,
  overrides: Partial<SurfaceReconcileDependencies> = {}
): Promise<SurfaceReconcileResult> {
  const deps = withSurfaceDefaults(overrides)
  return runSurfaceLocked(ctx.adapterId, chatId, "chat_tab", async () => {
    const adapterRow = await deps.getAdapter(ctx.adapterId).catch(() => undefined)
    if (!isLarkFeatureEnabled("larkChatTab", adapterRow)) return "skipped"

    const storedRow = await getChatSurface(ctx.adapterId, chatId, "chat_tab")
    const identity = resolveSurfaceIdentity(adapterRow, storedRow ?? {})

    const fail = async (reason: string): Promise<SurfaceReconcileResult> => {
      const row = await deps.markError(ctx.adapterId, chatId, "chat_tab", reason, deps.now())
      await deps.audit({
        adapterId: ctx.adapterId,
        kind: "chat_tab.sync_failed",
        at: deps.now(),
        reason,
        fields: { chatId, surfaceType: "chat_tab", attempt: row?.attempt },
      })
      return "error"
    }

    if (!identity) {
      // Ensure the row exists so the sweep retries once identity arrives.
      await deps.ensure({
        adapterId: ctx.adapterId,
        chatId,
        surfaceType: "chat_tab",
        urlVersion: CHAT_TAB_URL_VERSION,
        now: deps.now(),
      })
      return fail("identity_unknown")
    }

    const url = await deps.buildUrl({
      adapterRow,
      adapterId: ctx.adapterId,
      tenantKey: identity.tenantKey,
      appId: identity.appId,
      chatId,
      surface: "chat_tab",
    })
    if (!url) {
      await deps.ensure({
        adapterId: ctx.adapterId,
        chatId,
        surfaceType: "chat_tab",
        urlVersion: CHAT_TAB_URL_VERSION,
        tenantKey: identity.tenantKey,
        appId: identity.appId,
        now: deps.now(),
      })
      return fail("web_entry_unconfigured")
    }

    await deps.ensure({
      adapterId: ctx.adapterId,
      chatId,
      surfaceType: "chat_tab",
      urlVersion: CHAT_TAB_URL_VERSION,
      desiredUrl: url,
      tenantKey: identity.tenantKey,
      appId: identity.appId,
      now: deps.now(),
    })

    try {
      const creds = await ctx.resolveCreds()
      const tabs = await listChatTabs(deps, creds, chatId)
      const existing =
        tabs.find((tab) => tab.tab_id && tab.tab_id === storedRow?.platformSurfaceId) ??
        tabs.find((tab) => tab.tab_name === COGNIA_TAB_NAME)

      let tabId = existing?.tab_id
      if (existing?.tab_content?.url === url) {
        // Platform already matches the desired URL — nothing to write.
      } else if (existing?.tab_id) {
        await deps.request(
          creds,
          "POST",
          `/im/v1/chats/${encodeURIComponent(chatId)}/chat_tabs/update_tabs`,
          {
            chat_tabs: [
              {
                tab_id: existing.tab_id,
                tab_name: COGNIA_TAB_NAME,
                tab_type: "url",
                tab_content: { url },
              },
            ],
          }
        )
      } else {
        const created = (await deps.request(
          creds,
          "POST",
          `/im/v1/chats/${encodeURIComponent(chatId)}/chat_tabs`,
          { chat_tabs: [{ tab_name: COGNIA_TAB_NAME, tab_type: "url", tab_content: { url } }] }
        )) as { data?: { chat_tabs?: LarkChatTabRecord[] } } | null
        tabId = created?.data?.chat_tabs?.find((tab) => tab.tab_name === COGNIA_TAB_NAME)?.tab_id
      }

      await deps.markSynced(ctx.adapterId, chatId, "chat_tab", {
        platformSurfaceId: tabId,
        now: deps.now(),
      })
      await deps.audit({
        adapterId: ctx.adapterId,
        kind: "chat_tab.synced",
        at: deps.now(),
        fields: { chatId, surfaceType: "chat_tab", urlVersion: CHAT_TAB_URL_VERSION },
      })
      return "synced"
    } catch (err) {
      const classified = classifyScopeError(err, CHAT_TAB_WRITE_SCOPE) ?? err
      return fail(classified instanceof Error ? classified.message : String(classified))
    }
  })
}
