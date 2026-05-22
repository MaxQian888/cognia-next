"use client"

/**
 * Preset editor: External agent preset section.
 *
 * Single-select picker over `lib/ai/agent/external/presets.ts:getAvailablePresets()`
 * — the built-in five-tier list (`claude-code` / `codex` / `gemini-cli` /
 * `cursor-cli` / `custom`) extended with any plugin overlay entries the
 * `external-agent-preset` capability has registered. Selected id lands on
 * `state.externalAgentPresetId`.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SettingsCard } from "@/components/settings/common/settings-section"
import { getAvailablePresets, getPresetDisplayInfo } from "@/lib/ai/agent/external/presets"

import type { PresetEditorState } from "../preset-editor-state"

export interface ExternalPresetSectionProps {
  state: PresetEditorState
  onPatch: (patch: Partial<PresetEditorState>) => void
  defaultOpen?: boolean
}

const NONE_VALUE = "__inherit__"

export function ExternalPresetSection({
  state,
  onPatch,
  defaultOpen = false,
}: ExternalPresetSectionProps) {
  const t = useTranslations("presets.editor.sections.externalPreset")
  const ids = useMemo(() => getAvailablePresets(), [])
  const current = state.externalAgentPresetId ?? NONE_VALUE

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
