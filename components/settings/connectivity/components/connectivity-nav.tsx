"use client"

/**
 * Settings → Connectivity secondary nav. Binds the shared `SettingsPanelNav`
 * to this section's namespace and id space, as `logs-nav.tsx` does.
 */

import { useTranslations } from "next-intl"

import {
  SettingsPanelNav,
  type SettingsNavBadge,
} from "@/components/settings/common/settings-panel-nav"

import type {
  ConnectivityNavGroup,
  ConnectivityNavGroupId,
  ConnectivityPanelId,
} from "../nav-config"

export type ConnectivityNavBadge = SettingsNavBadge

export interface ConnectivityNavProps {
  groups: readonly ConnectivityNavGroup[]
  activeId: ConnectivityPanelId
  onSelect: (id: ConnectivityPanelId) => void
  badges?: Partial<Record<ConnectivityPanelId, ConnectivityNavBadge>>
  idPrefix?: string
}

export function ConnectivityNav({
  groups,
  activeId,
  onSelect,
  badges,
  idPrefix = "connectivity",
}: ConnectivityNavProps) {
  const t = useTranslations("settings.connectivity.nav")
  return (
    <SettingsPanelNav<ConnectivityPanelId, ConnectivityNavGroupId>
      groups={groups}
      activeId={activeId}
      onSelect={onSelect}
      badges={badges}
      idPrefix={idPrefix}
      labels={{
        title: t("title"),
        group: (groupId) => t(`groups.${groupId}`),
        item: (id) => ({
          label: t(`items.${id}.label`),
          description: t(`items.${id}.description`),
        }),
      }}
    />
  )
}
