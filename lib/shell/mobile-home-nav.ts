/**
 * Icon mapping + catalog assembly + layout resolver for the mobile home
 * quick-action grid (`components/mobile/home/mobile-quick-actions.tsx`).
 *
 * The pure (icon-free) catalog and `MobileHomeLayout` model live in
 * `@/types/shell/mobile-home`; this module is the only one that pulls in lucide,
 * so the persistence layer stays icon-free. `applyDragReorder` is shared with
 * the sidebar customizer (`@/lib/shell/sidebar-nav`).
 */

import {
  BotIcon,
  CompassIcon,
  InboxIcon,
  LayersIcon,
  PlusIcon,
  SearchIcon,
  UserRoundIcon,
  Users2Icon,
  WorkflowIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import {
  MOBILE_QUICK_ACTION_CATALOG,
  type MobileHomeLayout,
  type MobileQuickActionMeta,
} from "@/types/shell/mobile-home"

/** id → grid icon. Must cover every id in `MOBILE_QUICK_ACTION_CATALOG`. */
export const MOBILE_QUICK_ACTION_ICONS: Record<string, LucideIcon> = {
  newChat: PlusIcon,
  search: SearchIcon,
  workflows: WorkflowIcon,
  discover: CompassIcon,
  inbox: InboxIcon,
  twin: BotIcon,
  agentTeams: Users2Icon,
  fleet: LayersIcon,
  me: UserRoundIcon,
}

/** A catalog entry with its resolved icon. */
export interface MobileQuickActionItem extends MobileQuickActionMeta {
  Icon: LucideIcon
}

/** The quick-action catalog with icons attached, in canonical order. */
export function getMobileQuickActionCatalog(): MobileQuickActionItem[] {
  return MOBILE_QUICK_ACTION_CATALOG.map((m) => ({
    ...m,
    Icon: MOBILE_QUICK_ACTION_ICONS[m.id] ?? PlusIcon,
  }))
}

/** Resolved partition of the catalog into shown vs. available-to-add. */
export interface ResolvedMobileQuickActions {
  /** Actions shown on the home grid, in the user's stored order. */
  active: MobileQuickActionItem[]
  /** Catalog − active, in catalog order — the customizer's "add" pool. */
  available: MobileQuickActionItem[]
}

/**
 * Partition `catalog` according to `layout.quickActions`:
 *
 *  - **active**: `layout.quickActions` ids that exist in the catalog, in the
 *    user's stored order (deduped; unknown ids dropped).
 *  - **available**: everything else (catalog − active), in catalog order — so a
 *    newly-added catalog item shows up in the customizer automatically.
 */
export function resolveMobileHomeLayout(
  catalog: MobileQuickActionItem[],
  layout: MobileHomeLayout
): ResolvedMobileQuickActions {
  const byId = new Map(catalog.map((item) => [item.id, item]))

  const seen = new Set<string>()
  const active: MobileQuickActionItem[] = []
  for (const id of layout.quickActions) {
    if (seen.has(id)) continue
    const item = byId.get(id)
    if (!item) continue
    seen.add(id)
    active.push(item)
  }

  const available = catalog.filter((item) => !seen.has(item.id))
  return { active, available }
}
