/**
 * Lark group-menu reconciler (plan 2026-07-24 P4.3) — one "Cognia"
 * REDIRECT_LINK top-level menu per GROUP chat pointing at the authorized
 * surface URL. Links only, by design: group menus are visible to every
 * member, so they never execute anything directly — authorization happens
 * at resolve time (web SSO + membership check), exactly like Chat Tabs.
 *
 * API contract pinned against open.feishu.cn (server-docs/group/
 * chat-menu_tree, 2026-07): create `POST /im/v1/chats/{id}/menu_tree`
 * (body `menu_tree.chat_menu_top_levels[].chat_menu_item` with
 * `action_type: "REDIRECT_LINK"`, `name` 1-120 chars, `redirect_link
 * .common_url`, `i18n_names`), get `GET …/menu_tree`, delete
 * `DELETE …/menu_tree` ({chat_menu_top_level_ids}), patch
 * `PATCH …/menu_items/{menu_item_id}` (note: `menu_items`, NOT
 * `menu_tree`) with `update_fields: ["REDIRECT_LINK"]`. Write scope
 * `im:chat.menu_tree:write_only`; GROUP chats only (p2p unsupported);
 * ≤3 top-level menus; the bot must be in the group.
 */

import { isLarkFeatureEnabled } from "@/lib/connectors/feature-flags"
import { CHAT_TAB_URL_VERSION } from "@/lib/connectors/entry/deep-links"
import { getChatSurface } from "@/lib/db/lark-chat-surfaces"
import { classifyScopeError, type LarkCredentials } from "./http"
import {
  COGNIA_TAB_NAME,
  resolveSurfaceIdentity,
  runSurfaceLocked,
  withSurfaceDefaults,
  type SurfaceReconcileContext,
  type SurfaceReconcileDependencies,
  type SurfaceReconcileResult,
} from "./chat-tabs"

export const GROUP_MENU_WRITE_SCOPE = "im:chat.menu_tree:write_only"

interface LarkMenuItemRecord {
  action_type?: string
  name?: string
  redirect_link?: { common_url?: string }
}

interface LarkTopLevelMenuRecord {
  chat_menu_top_level_id?: string
  chat_menu_item?: LarkMenuItemRecord
}

async function getMenuTree(
  deps: SurfaceReconcileDependencies,
  creds: LarkCredentials,
  chatId: string
): Promise<LarkTopLevelMenuRecord[]> {
  const parsed = (await deps.request(
    creds,
    "GET",
    `/im/v1/chats/${encodeURIComponent(chatId)}/menu_tree`
  )) as { data?: { menu_tree?: { chat_menu_top_levels?: LarkTopLevelMenuRecord[] } } } | null
  return parsed?.data?.menu_tree?.chat_menu_top_levels ?? []
}

function cogniaMenuItem(url: string): Record<string, unknown> {
  return {
    action_type: "REDIRECT_LINK",
    name: COGNIA_TAB_NAME,
    redirect_link: { common_url: url },
    i18n_names: { zh_cn: COGNIA_TAB_NAME, en_us: COGNIA_TAB_NAME },
  }
}

/**
 * Reconcile the Cognia group-menu entry for one group chat. Same state
 * machine + backoff rows as Chat Tabs (`surfaceType: "group_menu"`).
 */
export async function reconcileGroupMenuSurface(
  ctx: SurfaceReconcileContext,
  chatId: string,
  overrides: Partial<SurfaceReconcileDependencies> = {}
): Promise<SurfaceReconcileResult> {
  const deps = withSurfaceDefaults(overrides)
  return runSurfaceLocked(ctx.adapterId, chatId, "group_menu", async () => {
    const adapterRow = await deps.getAdapter(ctx.adapterId).catch(() => undefined)
    if (!isLarkFeatureEnabled("larkGroupMenu", adapterRow)) return "skipped"

    const storedRow = await getChatSurface(ctx.adapterId, chatId, "group_menu")
    const identity = resolveSurfaceIdentity(adapterRow, storedRow ?? {})

    const fail = async (reason: string): Promise<SurfaceReconcileResult> => {
      const row = await deps.markError(ctx.adapterId, chatId, "group_menu", reason, deps.now())
      await deps.audit({
        adapterId: ctx.adapterId,
        kind: "chat_tab.sync_failed",
        at: deps.now(),
        reason,
        fields: { chatId, surfaceType: "group_menu", attempt: row?.attempt },
      })
      return "error"
    }

    const ensure = (desiredUrl?: string) =>
      deps.ensure({
        adapterId: ctx.adapterId,
        chatId,
        surfaceType: "group_menu",
        urlVersion: CHAT_TAB_URL_VERSION,
        ...(desiredUrl ? { desiredUrl } : {}),
        ...(identity ? { tenantKey: identity.tenantKey, appId: identity.appId } : {}),
        now: deps.now(),
      })

    if (!identity) {
      await ensure()
      return fail("identity_unknown")
    }

    const url = await deps.buildUrl({
      adapterRow,
      adapterId: ctx.adapterId,
      tenantKey: identity.tenantKey,
      appId: identity.appId,
      chatId,
      surface: "group_menu",
    })
    if (!url) {
      await ensure()
      return fail("web_entry_unconfigured")
    }
    await ensure(url)

    try {
      const creds = await ctx.resolveCreds()
      const topLevels = await getMenuTree(deps, creds, chatId)
      const existing =
        topLevels.find(
          (item) =>
            item.chat_menu_top_level_id &&
            item.chat_menu_top_level_id === storedRow?.platformSurfaceId
        ) ?? topLevels.find((item) => item.chat_menu_item?.name === COGNIA_TAB_NAME)

      let menuId = existing?.chat_menu_top_level_id
      if (existing?.chat_menu_item?.redirect_link?.common_url === url) {
        // Platform already points at the desired URL.
      } else if (existing?.chat_menu_top_level_id) {
        await deps.request(
          creds,
          "PATCH",
          `/im/v1/chats/${encodeURIComponent(chatId)}/menu_items/${encodeURIComponent(
            existing.chat_menu_top_level_id
          )}`,
          { update_fields: ["REDIRECT_LINK"], chat_menu_item: cogniaMenuItem(url) }
        )
      } else {
        const created = (await deps.request(
          creds,
          "POST",
          `/im/v1/chats/${encodeURIComponent(chatId)}/menu_tree`,
          { menu_tree: { chat_menu_top_levels: [{ chat_menu_item: cogniaMenuItem(url) }] } }
        )) as {
          data?: { menu_tree?: { chat_menu_top_levels?: LarkTopLevelMenuRecord[] } }
        } | null
        menuId = created?.data?.menu_tree?.chat_menu_top_levels?.find(
          (item) => item.chat_menu_item?.name === COGNIA_TAB_NAME
        )?.chat_menu_top_level_id
      }

      await deps.markSynced(ctx.adapterId, chatId, "group_menu", {
        platformSurfaceId: menuId,
        now: deps.now(),
      })
      await deps.audit({
        adapterId: ctx.adapterId,
        kind: "chat_tab.synced",
        at: deps.now(),
        fields: { chatId, surfaceType: "group_menu", urlVersion: CHAT_TAB_URL_VERSION },
      })
      return "synced"
    } catch (err) {
      const classified = classifyScopeError(err, GROUP_MENU_WRITE_SCOPE) ?? err
      return fail(classified instanceof Error ? classified.message : String(classified))
    }
  })
}
