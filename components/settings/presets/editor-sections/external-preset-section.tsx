"use client"

/**
 * Preset editor: External agent preset section.
 *
 * Single-select picker over `lib/ai/agent/external/presets.ts:getRunnablePresets()`
 * — the built-in five-tier list (`claude-code` / `codex` / `gemini-cli` /
 * `cursor-cli` / `custom`) extended with any plugin overlay entries the
 * `external-agent-preset` capability has registered. Selected id lands on
 * `state.externalAgentPresetId`.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SettingsCard } from "@/components/settings/common/settings-section"
import { getPresetDisplayInfo, getRunnablePresets } from "@/lib/ai/agent/external/presets"

import type { PresetEditorState } from "../preset-editor-state"

export interface ExternalPresetSectionProps {
  state: PresetEditorState
  onPatch: (patch: Partial<PresetEditorState>) => void
  defaultOpen?: boolean
  /** Multi-select mode (team capability pool). See CharacterSection. */
  multiple?: boolean
  selectedIds?: string[]
  onPatchMulti?: (ids: string[]) => void
}

const NONE_VALUE = "__inherit__"

export function ExternalPresetSection({
  state,
  onPatch,
  defaultOpen = false,
  multiple = false,
  selectedIds,
  onPatchMulti,
}: ExternalPresetSectionProps) {
  const t = useTranslations("presets.editor.sections.externalPreset")
  const ids = useMemo(() => getRunnablePresets(), [])
  const current = state.externalAgentPresetId ?? NONE_VALUE
  const selectedSet = useMemo(() => new Set(selectedIds ?? []), [selectedIds])

  if (multiple) {
    const toggleMulti = (id: string, next: boolean): void => {
      const updated = new Set(selectedSet)
      if (next) updated.add(id)
      else updated.delete(id)
      onPatchMulti?.(Array.from(updated))
    }
    return (
      <SettingsCard title={t("title")} description={t("description")} defaultOpen={defaultOpen}>
        <div className="space-y-2">
          {ids.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("inherit")}</p>
          ) : (
            ids.map((id) => {
              const info = getPresetDisplayInfo(id)
              return (
                <label key={id} className="flex items-center gap-2 rounded-md border p-2 text-xs">
                  <Checkbox
                    checked={selectedSet.has(id)}
                    onCheckedChange={(v) => toggleMulti(id, v === true)}
                  />
                  <span>{info?.name ?? id}</span>
                </label>
              )
            })
          )}
        </div>
      </SettingsCard>
    )
  }

  return (
    <SettingsCard title={t("title")} description={t("description")} defaultOpen={defaultOpen}>
      <div className="space-y-2">
        <Label className="text-xs">{t("pickerLabel")}</Label>
        <Select
          value={current}
          onValueChange={(v) =>
            onPatch({ externalAgentPresetId: v === NONE_VALUE ? undefined : v })
          }
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>{t("inherit")}</SelectItem>
            {ids.map((id) => {
              const info = getPresetDisplayInfo(id)
              return (
                <SelectItem key={id} value={id}>
                  {info?.name ?? id}
                </SelectItem>
              )
            })}
          </SelectContent>
        </Select>
      </div>
    </SettingsCard>
  )
}
