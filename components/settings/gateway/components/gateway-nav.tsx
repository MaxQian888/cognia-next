"use client"

/**
 * Settings → Gateway secondary nav.
 *
 * Binds the shared `SettingsPanelNav` to this section's namespace and id space.
 * The markup, motion and badge handling used to be a full copy of
 * `bridge-nav.tsx`; the only things that ever differed are the four values
 * passed below.
 */

import { useTranslations } from "next-intl"

import {
  SettingsPanelNav,
  type SettingsNavBadge,
} from "@/components/settings/common/settings-panel-nav"

import type { GatewayNavGroup, GatewayNavGroupId, GatewayPanelId } from "../nav-config"

export type GatewayNavBadge = SettingsNavBadge

export interface GatewayNavProps {
  groups: readonly GatewayNavGroup[]
  activeId: GatewayPanelId
  onSelect: (id: GatewayPanelId) => void
  badges?: Partial<Record<GatewayPanelId, GatewayNavBadge>>
}

export function GatewayNav({ groups, activeId, onSelect, badges }: GatewayNavProps) {
  const t = useTranslations("settings.gateway.nav")
  return (
    <SettingsPanelNav<GatewayPanelId, GatewayNavGroupId>
      groups={groups}
      activeId={activeId}
      onSelect={onSelect}
      badges={badges}
      idPrefix="gateway"
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
