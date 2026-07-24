/**
 * Sweep driver over `larkChatSurfaces` (plan 2026-07-24 P4.1/P4.3).
 *
 * Reconcile triggers:
 *   - adapter start (this sweep, fire-and-forget from `index.ts`),
 *   - `im.chat.member.bot.added_v1` (targeted, from `dispatchEnvelope`),
 *   - the Settings resync button (`resyncLarkChatSurfaces`),
 *   - urlVersion bumps (ensureChatSurface re-arms rows → next sweep).
 *
 * Both the start sweep and the resync SEED first (`seedLarkChatSurfaces`):
 * selection below only sees rows that already exist, so without seeding a
 * chat the bot was already in when the flag flipped would never get a
 * surface at all.
 *
 * Selection (pending / backoff-elapsed errors / >24 h-stale synced) lives in
 * `listDueChatSurfaces`; per-surface locking lives in the reconcilers.
 */

import { isLarkFeatureEnabled } from "@/lib/connectors/feature-flags"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import {
  listChatSurfaces,
  listDueChatSurfaces,
  setChatSurfaceStatus,
} from "@/lib/db/lark-chat-surfaces"
import { reconcileChatTabSurface } from "./chat-tabs"
import { reconcileGroupMenuSurface } from "./group-menu"
import { seedLarkChatSurfaces } from "./chat-seed"
import type { SurfaceReconcileContext, SurfaceReconcileDependencies } from "./chat-tabs"

export interface SurfaceSweepDependencies {
  getAdapter: typeof getAdapterInstance
  listDue: typeof listDueChatSurfaces
  reconcileTab: typeof reconcileChatTabSurface
  reconcileMenu: typeof reconcileGroupMenuSurface
  seed: typeof seedLarkChatSurfaces
}

function sweepDeps(overrides: Partial<SurfaceSweepDependencies>): SurfaceSweepDependencies {
  return {
    getAdapter: getAdapterInstance,
    listDue: listDueChatSurfaces,
    reconcileTab: reconcileChatTabSurface,
    reconcileMenu: reconcileGroupMenuSurface,
    seed: seedLarkChatSurfaces,
    ...overrides,
  }
}

/**
 * Reconcile every due surface for one adapter. Skips the Dexie scan
 * entirely when both surface flags are off. Serial on purpose: a fleet of
 * chats sharing one tenant token should not burst-write the platform API.
 */
export async function sweepLarkChatSurfaces(
  ctx: SurfaceReconcileContext,
  overrides: Partial<SurfaceSweepDependencies> = {},
  reconcileOverrides: Partial<SurfaceReconcileDependencies> = {}
): Promise<{ synced: number; errors: number; skipped: number }> {
  const deps = sweepDeps(overrides)
  const adapterRow = await deps.getAdapter(ctx.adapterId).catch(() => undefined)
  const tabsOn = isLarkFeatureEnabled("larkChatTab", adapterRow)
  const menusOn = isLarkFeatureEnabled("larkGroupMenu", adapterRow)
  const counts = { synced: 0, errors: 0, skipped: 0 }
  if (!tabsOn && !menusOn) return counts

  // Discover chats that have no desired-state row yet. Never fatal: a missing
  // `im:chat:readonly` scope must not stop the rows we already know about
  // from reconciling.
  await deps
    .seed({ adapterId: ctx.adapterId, resolveCreds: ctx.resolveCreds })
    .catch(() => undefined)

  const due = await deps.listDue(ctx.adapterId)
  for (const row of due) {
    const result =
      row.surfaceType === "chat_tab"
        ? tabsOn
          ? await deps.reconcileTab(ctx, row.chatId, reconcileOverrides)
          : "skipped"
        : menusOn
          ? await deps.reconcileMenu(ctx, row.chatId, reconcileOverrides)
          : "skipped"
    if (result === "synced") counts.synced += 1
    else if (result === "error" || result === "blocked") counts.errors += 1
    else counts.skipped += 1
  }
  return counts
}

/**
 * Settings-card resync: re-arm EVERY non-removed surface for the adapter
 * (not just the due ones) and run a sweep immediately.
 */
export async function resyncLarkChatSurfaces(
  ctx: SurfaceReconcileContext,
  overrides: Partial<SurfaceSweepDependencies> = {},
  reconcileOverrides: Partial<SurfaceReconcileDependencies> = {}
): Promise<{ synced: number; errors: number; skipped: number }> {
  const rows = await listChatSurfaces(ctx.adapterId)
  for (const row of rows) {
    if (row.status === "removed") continue
    await setChatSurfaceStatus(row.adapterId, row.chatId, row.surfaceType, "pending")
  }
  return sweepLarkChatSurfaces(ctx, overrides, reconcileOverrides)
}
