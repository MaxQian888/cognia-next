/**
 * Panels of the Settings → Connectivity master/detail pane (ADR-0170).
 *
 * Replaces two sections that split one question in half: "Mobile companion"
 * (this device's server, tunnel, mDNS, pairing QR, push) and "Remote hosts"
 * (the registry of hosts this device drives). Both are about how this device
 * and a Host reach each other, and since the relay every Host now dials into
 * is the same rendezvous whichever side you sit on, they read as one surface.
 *
 * Grouped by what a setting changes: what this device can be reached as, what
 * it reaches through, who is paired to whom, and what leaves the Host after
 * the socket closes. Mirrors `../logs/nav-config.ts` and its siblings so the
 * sections share a shell.
 */

import {
  ActivityIcon,
  BellIcon,
  CloudIcon,
  HardDriveIcon,
  QrCodeIcon,
  RefreshCwIcon,
  ServerIcon,
} from "lucide-react"

import { panelIdSet, resolvePanelId } from "@/components/settings/common/resolve-panel-id"
import type {
  SettingsNavGroup,
  SettingsNavItem,
} from "@/components/settings/common/settings-panel-nav"

export type ConnectivityPanelId =
  "overview" | "local-host" | "cloud-relay" | "pairing" | "remote-hosts" | "push" | "sync"

export type ConnectivityNavGroupId = "statusGroup" | "hostGroup" | "devicesGroup" | "deliveryGroup"

export type ConnectivityNavItem = SettingsNavItem<ConnectivityPanelId>

export type ConnectivityNavGroup = SettingsNavGroup<ConnectivityPanelId, ConnectivityNavGroupId>

export const CONNECTIVITY_NAV_GROUPS: readonly ConnectivityNavGroup[] = [
  {
    id: "statusGroup",
    items: [{ id: "overview", icon: ActivityIcon }],
  },
  {
    id: "hostGroup",
    items: [
      { id: "local-host", icon: HardDriveIcon },
      { id: "cloud-relay", icon: CloudIcon },
    ],
  },
  {
    id: "devicesGroup",
    items: [
      { id: "pairing", icon: QrCodeIcon },
      { id: "remote-hosts", icon: ServerIcon },
    ],
  },
  {
    id: "deliveryGroup",
    items: [
      { id: "push", icon: BellIcon },
      { id: "sync", icon: RefreshCwIcon },
    ],
  },
]

export const CONNECTIVITY_NAV_ITEMS: readonly ConnectivityNavItem[] =
  CONNECTIVITY_NAV_GROUPS.flatMap((group) => group.items)

const PANEL_IDS = panelIdSet(CONNECTIVITY_NAV_ITEMS)

export const CONNECTIVITY_PANEL_PARAM = "connectivityPanel"

export const DEFAULT_CONNECTIVITY_PANEL: ConnectivityPanelId = "overview"

/** Narrow an untrusted deep-link value, falling back to the overview panel. */
export function resolveConnectivityPanel(raw: string | null | undefined): ConnectivityPanelId {
  return resolvePanelId(raw, PANEL_IDS, DEFAULT_CONNECTIVITY_PANEL)
}

/**
 * Where the retired sections' deep links land. `?section=companion` opened the
 * local server and its pairing QR, `?section=remote-hosts` the registry, and
 * its `?remoteHostsTab=add` the pairing form for a new host.
 */
export function panelForLegacySection(
  section: "companion" | "remote-hosts",
  remoteHostsTab?: string | null
): ConnectivityPanelId {
  if (section === "remote-hosts") return "remote-hosts"
  return remoteHostsTab ? "remote-hosts" : "overview"
}
