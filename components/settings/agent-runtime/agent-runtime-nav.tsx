"use client"

/**
 * Settings → Built-in Agent Runtime secondary nav.
 *
 * Binds the shared `SettingsPanelNav` to this section's namespace and id space
 * — the same three-value binding `gateway-nav.tsx` and `bridge-nav.tsx` do.
 * Nothing about the markup, motion or badges is section-specific, so nothing
 * about them is duplicated here.
 */

import { useTranslations } from "next-intl"

import {
  SettingsPanelNav,
  type SettingsNavBadge,
} from "@/components/settings/common/settings-panel-nav"

import type {
  AgentRuntimeNavGroup,
  AgentRuntimeNavGroupId,
  AgentRuntimePanelId,
} from "./nav-config"

export type AgentRuntimeNavBadge = SettingsNavBadge

export interface AgentRuntimeNavProps {
  groups: readonly AgentRuntimeNavGroup[]
  activeId: AgentRuntimePanelId
  onSelect: (id: AgentRuntimePanelId) => void
  badges?: Partial<Record<AgentRuntimePanelId, AgentRuntimeNavBadge>>
  /**
   * Distinguishes the two mounts of this nav. The desktop rail is only
   * `display:none` below `md`, so while the mobile Sheet is open BOTH copies
   * are in the tree — and `SettingsPanelNav` derives its shared-layout
   * `layoutId` from this prefix. Two elements carrying one layoutId make
   * Motion pick between them, which lit the selection pill on a second,
   * unselected row. The Sheet copy passes its own prefix so each nav owns a
   * pill.
   */
  idPrefix?: string
}

export function AgentRuntimeNav({
  groups,
  activeId,
  onSelect,
  badges,
  idPrefix = "agent-runtime",
}: AgentRuntimeNavProps) {
  const t = useTranslations("settings.agentRuntimeSection.nav")
  return (
    <SettingsPanelNav<AgentRuntimePanelId, AgentRuntimeNavGroupId>
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
