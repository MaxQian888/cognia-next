/**
 * Panels of the Settings → External Bridge master/detail pane, plus the scope
 * grouping the permissions panel renders.
 *
 * Replaces the six-card single scroll the section used to be. The bridge
 * scopes were previously a flat list of raw `namespace:verb` strings (the
 * file's own header claimed nine); grouping them by namespace is what makes
 * that list scannable without renaming anything on the wire.
 */

import {
  BookOpenIcon,
  BotIcon,
  BrainIcon,
  InboxIcon,
  KeyRoundIcon,
  MonitorIcon,
  PuzzleIcon,
  ScrollTextIcon,
  SearchIcon,
  ServerIcon,
  ShieldIcon,
  TerminalIcon,
  WebhookIcon,
  WorkflowIcon,
  WrenchIcon,
  type LucideIcon,
} from "lucide-react"

import { panelIdSet, resolvePanelId } from "@/components/settings/common/resolve-panel-id"
import type {
  SettingsNavGroup,
  SettingsNavItem,
} from "@/components/settings/common/settings-panel-nav"
import { ALL_BRIDGE_SCOPES, type BridgeScope } from "@/types/wiki"

export type BridgePanelId = "server" | "scopes" | "wiki" | "inbound" | "setup" | "audit"

export type BridgeNavGroupId = "serviceGroup" | "contentGroup" | "accessGroup"

export type BridgeNavItem = SettingsNavItem<BridgePanelId>

export type BridgeNavGroup = SettingsNavGroup<BridgePanelId, BridgeNavGroupId>

export const BRIDGE_NAV_GROUPS: readonly BridgeNavGroup[] = [
  {
    id: "serviceGroup",
    items: [
      { id: "server", icon: ServerIcon },
      { id: "scopes", icon: ShieldIcon },
    ],
  },
  {
    id: "contentGroup",
    items: [
      { id: "wiki", icon: BookOpenIcon },
      { id: "inbound", icon: InboxIcon },
    ],
  },
  {
    id: "accessGroup",
    items: [
      { id: "setup", icon: TerminalIcon },
      { id: "audit", icon: ScrollTextIcon },
    ],
  },
]

export const BRIDGE_NAV_ITEMS: readonly BridgeNavItem[] = BRIDGE_NAV_GROUPS.flatMap(
  (group) => group.items
)

const PANEL_IDS = panelIdSet(BRIDGE_NAV_ITEMS)

export const BRIDGE_PANEL_PARAM = "bridgePanel"

export const DEFAULT_BRIDGE_PANEL: BridgePanelId = "server"

/** Narrow an untrusted deep-link value, falling back to the server panel. */
export function resolveBridgePanel(raw: string | null | undefined): BridgePanelId {
  return resolvePanelId(raw, PANEL_IDS, DEFAULT_BRIDGE_PANEL)
}

// ---- Scope grouping ---------------------------------------------------------

export type ScopeGroupId =
  | "wiki"
  | "rag"
  | "runtime"
  | "mcp"
  | "inbox"
  | "agent"
  | "plugin"
  | "inbound"
  | "memory"
  | "workflow"

export interface ScopeGroup {
  id: ScopeGroupId
  icon: LucideIcon
  scopes: BridgeScope[]
}

const GROUP_ICONS: Record<ScopeGroupId, LucideIcon> = {
  wiki: BookOpenIcon,
  rag: SearchIcon,
  runtime: WrenchIcon,
  mcp: MonitorIcon,
  inbox: InboxIcon,
  agent: BotIcon,
  plugin: PuzzleIcon,
  inbound: WebhookIcon,
  memory: BrainIcon,
  workflow: WorkflowIcon,
}

const GROUP_ORDER: ScopeGroupId[] = [
  "wiki",
  "rag",
  "runtime",
  "memory",
  "agent",
  "workflow",
  "inbox",
  "plugin",
  "mcp",
  "inbound",
]

/**
 * Bucket every scope by its namespace prefix, derived from `ALL_BRIDGE_SCOPES`
 * rather than hand-listed — a scope added to the type but not to a group here
 * would otherwise silently vanish from the UI while still being grantable.
 */
export function groupBridgeScopes(
  scopes: readonly BridgeScope[] = ALL_BRIDGE_SCOPES
): ScopeGroup[] {
  const buckets = new Map<ScopeGroupId, BridgeScope[]>()
  for (const scope of scopes) {
    const id = scope.split(":")[0] as ScopeGroupId
    const bucket = buckets.get(id)
    if (bucket) bucket.push(scope)
    else buckets.set(id, [scope])
  }
  const ordered = GROUP_ORDER.filter((id) => buckets.has(id))
  // Anything with an unrecognised prefix still renders, after the known groups.
  const extras = [...buckets.keys()].filter((id) => !GROUP_ORDER.includes(id))
  return [...ordered, ...extras].map((id) => ({
    id,
    icon: GROUP_ICONS[id] ?? KeyRoundIcon,
    scopes: buckets.get(id) ?? [],
  }))
}
