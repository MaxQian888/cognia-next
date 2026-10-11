/**
 * Icon mapping + catalog assembly + shortcut resolver for the phone's quick
 * module (`components/mobile/glance/mobile-glance-quick-module.tsx`) and its
 * editor (`components/mobile/glance/mobile-shortcuts-editor.tsx`).
 *
 * The pure (icon-free) catalog lives in
 * `@/types/shell/mobile-home`; this module is the only one that pulls in lucide,
 * so the persistence layer stays icon-free. `applyDragReorder` is shared with
 * the sidebar customizer (`@/lib/shell/sidebar-nav`).
 */

import { AgentTeamIcon } from "@/components/mobile/mobile-spot-icon"
import {
  BotIcon,
  CompassIcon,
  FileArchiveIcon,
  InboxIcon,
  LayersIcon,
  PlusIcon,
  SearchIcon,
  SmartphoneIcon,
  ServerCogIcon,
  UserRoundIcon,
  WorkflowIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import type { MobileSpotIconName } from "@/components/mobile/mobile-spot-icon"
import {
  LEGACY_MOBILE_QUICK_ACTION_IDS,
  MOBILE_QUICK_ACTION_CATALOG,
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
  squads: AgentTeamIcon,
  // The same icon the Studio's own page header carries.
  templates: FileArchiveIcon,
  fleet: LayersIcon,
  servers: ServerCogIcon,
  devices: SmartphoneIcon,
  me: UserRoundIcon,
}

/** id → spacious-card illustration. Dense editor rows keep the Lucide map above. */
export const MOBILE_QUICK_ACTION_SPOT_ICONS: Record<string, MobileSpotIconName> = {
  newChat: "chat",
  search: "discover",
  workflows: "workflows",
  discover: "discover",
  inbox: "inbox",
  twin: "digital-twin",
  squads: "agent-teams",
  templates: "templates",
  fleet: "fleet",
  servers: "servers",
  devices: "devices",
  me: "profile",
}

/** A catalog entry with its resolved icon. */
export interface MobileQuickActionItem extends MobileQuickActionMeta {
  Icon: LucideIcon
  spotIcon: MobileSpotIconName
}

/** The quick-action catalog with icons attached, in canonical order. */
export function getMobileQuickActionCatalog(): MobileQuickActionItem[] {
  return MOBILE_QUICK_ACTION_CATALOG.map((m) => ({
    ...m,
    Icon: MOBILE_QUICK_ACTION_ICONS[m.id] ?? PlusIcon,
    spotIcon: MOBILE_QUICK_ACTION_SPOT_ICONS[m.id] ?? "chat",
  }))
}

/** Resolved partition of the catalog into shown vs. available-to-add. */
export interface ResolvedMobileQuickActions {
  /** Shortcuts shown, in the user's stored order. */
  active: MobileQuickActionItem[]
  /** Catalog − active, in catalog order — the editor's "add" pool. */
  available: MobileQuickActionItem[]
}

/**
 * Partition `catalog` by a stored shortcut list (`mobileGlanceLayout.shortcuts`,
 * formerly `mobileHomeLayout.quickActions`):
 *
 *  - **active**: the stored ids that exist in the catalog, in the user's
 *    stored order (deduped; renamed ids mapped; unknown ids dropped).
 *  - **available**: everything else (catalog − active), in catalog order — so a
 *    newly-added catalog item shows up in the editor automatically.
 */
export function resolveMobileShortcuts(
  catalog: MobileQuickActionItem[],
  shortcuts: readonly string[]
): ResolvedMobileQuickActions {
  const byId = new Map(catalog.map((item) => [item.id, item]))

  const seen = new Set<string>()
  const active: MobileQuickActionItem[] = []
  for (const stored of shortcuts) {
    // Renamed ids are mapped on read. Dropping them instead would delete the
    // tile from every saved grid rather than moving it.
    const id = LEGACY_MOBILE_QUICK_ACTION_IDS[stored] ?? stored
    if (seen.has(id)) continue
    const item = byId.get(id)
    if (!item) continue
    seen.add(id)
    active.push(item)
  }

  const available = catalog.filter((item) => !seen.has(item.id))
  return { active, available }
}
