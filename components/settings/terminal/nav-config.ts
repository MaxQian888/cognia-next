/**
 * Panels of the Settings → Terminal master/detail pane.
 *
 * The section used to be one card, about thirteen hundred lines tall, with the
 * SSH host editor at the very bottom under fonts, cursors, autocomplete and the
 * durable host's replay budgets. Nothing linked into it, so every "fix this in
 * Settings → Terminal" (a missing SSH password, a changed jump host, a tunnel
 * rule) landed on the font picker and left the user to scroll. The groups the
 * card already drew become panels here, and the three editors that sat under
 * the card get panels of their own.
 *
 * Grouped by what a setting changes: how the terminal looks and behaves, the
 * host process that owns the sessions, where a new tab can connect to, and the
 * per-workspace override. Mirrors `../connectivity/nav-config.ts` so the
 * sections share a shell.
 */

import {
  BotIcon,
  FolderCogIcon,
  KeyboardIcon,
  ListChecksIcon,
  PaletteIcon,
  ServerIcon,
  SparklesIcon,
  SquareTerminalIcon,
  UserCogIcon,
  WaypointsIcon,
} from "lucide-react"

import { panelIdSet, resolvePanelId } from "@/components/settings/common/resolve-panel-id"
import type {
  SettingsNavGroup,
  SettingsNavItem,
} from "@/components/settings/common/settings-panel-nav"
import {
  TERMINAL_PANEL_IDS,
  TERMINAL_PANEL_PARAM,
  type TerminalPanelId,
} from "@/lib/terminal/terminal-settings-link"

export type { TerminalPanelId }
export { TERMINAL_PANEL_PARAM }

export type TerminalNavGroupId = "generalGroup" | "hostGroup" | "connectGroup" | "workspaceGroup"

export type TerminalNavItem = SettingsNavItem<TerminalPanelId>

export type TerminalNavGroup = SettingsNavGroup<TerminalPanelId, TerminalNavGroupId>

export const TERMINAL_NAV_GROUPS: readonly TerminalNavGroup[] = [
  {
    id: "generalGroup",
    items: [
      { id: "appearance", icon: PaletteIcon },
      { id: "shell", icon: SquareTerminalIcon },
      { id: "behavior", icon: KeyboardIcon },
      { id: "productivity", icon: ListChecksIcon },
      { id: "ai", icon: SparklesIcon },
    ],
  },
  {
    id: "hostGroup",
    items: [
      { id: "host", icon: ServerIcon },
      { id: "agents", icon: BotIcon },
    ],
  },
  {
    id: "connectGroup",
    items: [
      { id: "profiles", icon: UserCogIcon },
      { id: "ssh", icon: WaypointsIcon },
    ],
  },
  {
    id: "workspaceGroup",
    items: [{ id: "project", icon: FolderCogIcon }],
  },
]

export const TERMINAL_NAV_ITEMS: readonly TerminalNavItem[] = TERMINAL_NAV_GROUPS.flatMap(
  (group) => group.items
)

const PANEL_IDS = panelIdSet(TERMINAL_NAV_ITEMS)

export const DEFAULT_TERMINAL_PANEL: TerminalPanelId = "appearance"

/** Narrow an untrusted deep-link value, falling back to the first panel. */
export function resolveTerminalPanel(raw: string | null | undefined): TerminalPanelId {
  return resolvePanelId(raw, PANEL_IDS, DEFAULT_TERMINAL_PANEL)
}

/**
 * Every id the link builder accepts has a rail entry. A panel id added to one
 * list and not the other would build links that silently land on Appearance.
 */
export function terminalNavCoversEveryPanel(): boolean {
  return (
    TERMINAL_PANEL_IDS.every((id) => PANEL_IDS.has(id)) &&
    PANEL_IDS.size === TERMINAL_PANEL_IDS.length
  )
}
