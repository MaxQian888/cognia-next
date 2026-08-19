"use client"

/**
 * Settings → Observability → Logs secondary nav.
 *
 * Binds the shared `SettingsPanelNav` to this section's namespace and id
 * space, exactly as `gateway-nav.tsx` and `bridge-nav.tsx` do.
 */

import { useTranslations } from "next-intl"

import {
  SettingsPanelNav,
  type SettingsNavBadge,
} from "@/components/settings/common/settings-panel-nav"

import type { LogsNavGroup, LogsNavGroupId, LogsPanelId } from "../nav-config"

export type LogsNavBadge = SettingsNavBadge

export interface LogsNavProps {
  groups: readonly LogsNavGroup[]
  activeId: LogsPanelId
  onSelect: (id: LogsPanelId) => void
  badges?: Partial<Record<LogsPanelId, LogsNavBadge>>
  /**
   * The desktop rail is only `display:none` below `md`, so it and the Sheet
   * copy are both mounted while the Sheet is open and must not share one
   * shared-layout pill id.
   */
  idPrefix?: string
}

export function LogsNav({ groups, activeId, onSelect, badges, idPrefix = "logs" }: LogsNavProps) {
  const t = useTranslations("logging.settings.nav")
  return (
    <SettingsPanelNav<LogsPanelId, LogsNavGroupId>
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
