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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"

/** Sentinel item value — Radix Select forbids `""` as an item value. */
const NONE_VALUE = "__none__"

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
  const missing = Boolean(value && !teams[value])

  return (
    <Select
      value={value ?? NONE_VALUE}
      onValueChange={(v) => onChange(v === NONE_VALUE ? undefined : v)}
      disabled={disabled}
    >
      <SelectTrigger id={id} data-testid="team-picker-trigger" aria-label={t("aria")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE_VALUE} data-testid="team-picker-none">
          {t("none")}
        </SelectItem>
        {missing && (
          <SelectItem
            value={value as string}
            className="text-destructive"
            data-testid="team-picker-missing"
          >
            {t("missing", { id: (value as string).slice(0, 12) })}
          </SelectItem>
        )}
        {list.map((team) => (
          <SelectItem key={team.id} value={team.id} data-testid={`team-picker-item-${team.id}`}>
            {team.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
