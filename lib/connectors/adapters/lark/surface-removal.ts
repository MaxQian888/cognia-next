/**
 * Take a published Cognia chat surface back down (plan 2026-07-24 P4, rollback).
 *
 * Flipping `larkChatTab` / `larkGroupMenu` off used to make the reconciler
 * return `"skipped"` and nothing else: the tab or menu stayed live in every
 * chat, still pointing at a URL the operator had just decided to withdraw. The
 * runbook's answer was "remove them manually", which does not scale past a
 * handful of chats and leaves dangling public entry points in the meantime.
 *
 * API contract (open.feishu.cn, 2026-07):
 *   - `DELETE /im/v1/chats/{id}/chat_tabs/delete_tabs` body `{tab_ids}`
 *   - `DELETE /im/v1/chats/{id}/menu_tree` body `{chat_menu_top_level_ids}`
 *
 * Removal is best-effort by design: a chat the bot was kicked from, or a tab a
 * human already deleted, must still reach the `removed` state locally instead
 * of wedging the row in a retry loop over something that is already gone.
 */

import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { appendAudit } from "@/lib/connectors/audit"
import type { LarkChatSurfaceRow, LarkChatSurfaceType } from "@/lib/db/connector-types"
import { listChatSurfaces, setChatSurfaceStatus } from "@/lib/db/lark-chat-surfaces"
import { isLarkFeatureEnabled } from "@/lib/connectors/feature-flags"
import { larkTenantRequest, type LarkCredentials } from "./http"
import type { SurfaceReconcileContext } from "./chat-tabs"

export interface SurfaceRemovalDependencies {
  request: typeof larkTenantRequest
  getAdapter: typeof getAdapterInstance
  setStatus: typeof setChatSurfaceStatus
  list: typeof listChatSurfaces
  audit: typeof appendAudit
  now: () => number
}

function withDefaults(overrides: Partial<SurfaceRemovalDependencies>): SurfaceRemovalDependencies {
  return {
    request: larkTenantRequest,
    getAdapter: getAdapterInstance,
    setStatus: setChatSurfaceStatus,
    list: listChatSurfaces,
    audit: appendAudit,
    now: Date.now,
    ...overrides,
  }
}

/**
 * Delete one published surface platform-side. Resolves even when it is gone.
 *
 * Module-private: `removeChatSurface` is the only caller and the only entry
 * anyone should use, because it also settles the local row. Exporting this
 * offered a way to delete the surface platform-side and leave the row behind.
 */
async function removePlatformSurface(
  deps: SurfaceRemovalDependencies,
  creds: LarkCredentials,
  chatId: string,
  surfaceType: LarkChatSurfaceType,
  platformSurfaceId: string
): Promise<void> {
  if (surfaceType === "chat_tab") {
    await deps.request(
      creds,
      "DELETE",
      `/im/v1/chats/${encodeURIComponent(chatId)}/chat_tabs/delete_tabs`,
      { tab_ids: [platformSurfaceId] }
    )
    return
  }
  await deps.request(creds, "DELETE", `/im/v1/chats/${encodeURIComponent(chatId)}/menu_tree`, {
    chat_menu_top_level_ids: [platformSurfaceId],
  })
}

export interface RemoveSurfacesResult {
  removed: number
  failed: number
}

/**
 * Withdraw one surface row: delete platform-side when we know its id, then
 * mark the local row `removed` either way. `removed` is terminal for the
 * sweep, so a withdrawn surface never silently reappears.
 */
export async function removeChatSurface(
  ctx: SurfaceReconcileContext,
  row: Pick<LarkChatSurfaceRow, "chatId" | "surfaceType" | "platformSurfaceId">,
  overrides: Partial<SurfaceRemovalDependencies> = {}
): Promise<boolean> {
  const deps = withDefaults(overrides)
  let ok = true
  if (row.platformSurfaceId) {
    try {
      const creds = await ctx.resolveCreds()
      await removePlatformSurface(deps, creds, row.chatId, row.surfaceType, row.platformSurfaceId)
    } catch {
      // Already gone, bot removed from the chat, or scope withdrawn — the
      // local row still moves to `removed` so the sweep stops touching it.
      ok = false
    }
  }
  await deps.setStatus(ctx.adapterId, row.chatId, row.surfaceType, "removed", deps.now())
  await deps
    .audit({
      adapterId: ctx.adapterId,
      kind: "chat_tab.removed",
      at: deps.now(),
      ...(ok ? {} : { reason: "platform_delete_failed" }),
      fields: { chatId: row.chatId, surfaceType: row.surfaceType },
    })
    .catch(() => undefined)
  return ok
}

/**
 * Withdraw every surface whose feature flag is now off. Called from the
 * settings card when an operator flips a surface flag down, so the rollback
 * lever in the runbook is a button rather than a manual API session.
 */
export async function removeDisabledLarkSurfaces(
  ctx: SurfaceReconcileContext,
  overrides: Partial<SurfaceRemovalDependencies> = {}
): Promise<RemoveSurfacesResult> {
  const deps = withDefaults(overrides)
  const adapterRow = await deps.getAdapter(ctx.adapterId).catch(() => undefined)
  const tabsOn = isLarkFeatureEnabled("larkChatTab", adapterRow)
  const menusOn = isLarkFeatureEnabled("larkGroupMenu", adapterRow)
  const result: RemoveSurfacesResult = { removed: 0, failed: 0 }

  for (const row of await deps.list(ctx.adapterId)) {
    if (row.status === "removed") continue
    const stillEnabled = row.surfaceType === "chat_tab" ? tabsOn : menusOn
    if (stillEnabled) continue
    const ok = await removeChatSurface(ctx, row, overrides)
    if (ok) result.removed += 1
    else result.failed += 1
  }
  return result
}
