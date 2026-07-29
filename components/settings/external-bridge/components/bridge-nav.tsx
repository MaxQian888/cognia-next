"use client"

/**
 * Settings → External Bridge secondary nav.
 *
 * Binds the shared `SettingsPanelNav` to this section's namespace and id space.
 * The two sections sit next to each other in the settings sidebar, so a
 * divergence would read as a bug — which is why this and `gateway-nav.tsx` were
 * byte-identical ~140-line copies, and why they now share one component instead
 * of an instruction to keep them in step by hand.
 */

import { useTranslations } from "next-intl"

import {
  SettingsPanelNav,
  type SettingsNavBadge,
} from "@/components/settings/common/settings-panel-nav"

import type { BridgeNavGroup, BridgeNavGroupId, BridgePanelId } from "../nav-config"

export type BridgeNavBadge = SettingsNavBadge

export interface BridgeNavProps {
  groups: readonly BridgeNavGroup[]
  activeId: BridgePanelId
  onSelect: (id: BridgePanelId) => void
  badges?: Partial<Record<BridgePanelId, BridgeNavBadge>>
}

export function BridgeNav({ groups, activeId, onSelect, badges }: BridgeNavProps) {
  const t = useTranslations("settings.externalBridge.nav")
  return (
    <SettingsPanelNav<BridgePanelId, BridgeNavGroupId>
      groups={groups}
      activeId={activeId}
      onSelect={onSelect}
      badges={badges}
      idPrefix="bridge"
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
