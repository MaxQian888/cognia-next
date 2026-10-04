"use client"

/**
 * Settings → Terminal secondary nav. Binds the shared `SettingsPanelNav` to
 * this section's namespace and id space, as `connectivity-nav.tsx` does.
 */

import { useTranslations } from "next-intl"

import {
  SettingsPanelNav,
  type SettingsNavBadge,
} from "@/components/settings/common/settings-panel-nav"

import type { TerminalNavGroup, TerminalNavGroupId, TerminalPanelId } from "../nav-config"

export interface TerminalNavProps {
  groups: readonly TerminalNavGroup[]
  activeId: TerminalPanelId
  onSelect: (id: TerminalPanelId) => void
  badges?: Partial<Record<TerminalPanelId, SettingsNavBadge>>
  idPrefix?: string
}

export function TerminalNav({
  groups,
  activeId,
  onSelect,
  badges,
  idPrefix = "terminal",
}: TerminalNavProps) {
  const t = useTranslations("settings.terminal.nav")
  return (
    <SettingsPanelNav<TerminalPanelId, TerminalNavGroupId>
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
