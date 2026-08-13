"use client"

/**
 * TeamPicker — shared Agent-Team select for connector settings surfaces.
 *
 * Callback-based (mirrors `ProviderModelSwitcher.onChange`) so it stays
 * persistence-agnostic: `AiBindingDefaults` persists to the adapter row, and
 * the inbox override form can later drop it in for `ConversationOverrideRow`.
 * A bound team id that no longer exists in the store is still rendered (as a
 * destructive "missing" entry) so the operator can SEE and clear a stale
 * binding instead of staring at an empty select.
 */

import { useTranslations } from "next-intl"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { EntityPicker } from "./entity-picker"

export interface TeamPickerProps {
  value?: string
  onChange: (teamId: string | undefined) => void
  disabled?: boolean
  id?: string
}

export function TeamPicker({ value, onChange, disabled, id }: TeamPickerProps) {
  const t = useTranslations("settings.connections.teamPicker")
  const teams = useAgentTeamStore((s) => s.teams)
  const list = Object.values(teams).sort((a, b) => a.name.localeCompare(b.name))
  return (
    <EntityPicker
      id={id ?? "team-picker"}
      triggerTestId="team-picker-trigger"
      value={value}
      items={list.map((team) => ({ id: team.id, label: team.name }))}
      emptyLabel={t("none")}
      missingLabel={(missingId) => t("missing", { id: missingId.slice(0, 12) })}
      onChange={onChange}
      disabled={disabled}
    />
  )
}
