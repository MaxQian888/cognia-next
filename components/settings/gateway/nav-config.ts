/**
 * Panels of the Settings → Gateway master/detail pane.
 *
 * Replaces the six-card single scroll the section used to be (~2000px, no
 * secondary nav). The split follows the question each panel answers rather than
 * the order the features shipped in: "is it up and healthy" (service), "how
 * does it choose and protect upstreams" (routing), "what has it actually done"
 * (observability).
 *
 * Plain data so the nav, the deep-link resolver and the tests all read one list.
 */

import {
  ActivityIcon,
  EyeIcon,
  FileSlidersIcon,
  GaugeIcon,
  KeyRoundIcon,
  RadioIcon,
  ScrollTextIcon,
  ShieldIcon,
  TicketIcon,
} from "lucide-react"

import { panelIdSet, resolvePanelId } from "@/components/settings/common/resolve-panel-id"
import type {
  SettingsNavGroup,
  SettingsNavItem,
} from "@/components/settings/common/settings-panel-nav"

export type GatewayPanelId =
  | "overview"
  | "listener"
  | "keys"
  | "reliability"
  | "upstream"
  | "exposure"
  | "logs"
  | "tickets"
  | "custom"

export type GatewayNavGroupId = "serviceGroup" | "routingGroup" | "observabilityGroup"

export type GatewayNavItem = SettingsNavItem<GatewayPanelId>

export type GatewayNavGroup = SettingsNavGroup<GatewayPanelId, GatewayNavGroupId>

// Group ids are suffixed so `nav.groups.serviceGroup` never reads as
// `nav.items.service` at a glance (the convention Appearance established).
export const GATEWAY_NAV_GROUPS: readonly GatewayNavGroup[] = [
  {
    id: "serviceGroup",
    items: [
      { id: "overview", icon: GaugeIcon },
      { id: "listener", icon: RadioIcon },
      { id: "keys", icon: KeyRoundIcon },
    ],
  },
  {
    id: "routingGroup",
    items: [
      { id: "reliability", icon: ActivityIcon },
      { id: "upstream", icon: ShieldIcon },
      { id: "exposure", icon: EyeIcon },
    ],
  },
  {
    id: "observabilityGroup",
    items: [
      { id: "logs", icon: ScrollTextIcon },
      { id: "tickets", icon: TicketIcon },
      { id: "custom", icon: FileSlidersIcon },
    ],
  },
]

export const GATEWAY_NAV_ITEMS: readonly GatewayNavItem[] = GATEWAY_NAV_GROUPS.flatMap(
  (group) => group.items
)

const PANEL_IDS = panelIdSet(GATEWAY_NAV_ITEMS)

export const GATEWAY_PANEL_PARAM = "gatewayPanel"

export const DEFAULT_GATEWAY_PANEL: GatewayPanelId = "overview"

/** Narrow an untrusted deep-link value, falling back to the overview. */
export function resolveGatewayPanel(raw: string | null | undefined): GatewayPanelId {
  return resolvePanelId(raw, PANEL_IDS, DEFAULT_GATEWAY_PANEL)
}
