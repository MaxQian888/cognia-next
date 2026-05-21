"use client"

// Preset editor: Capability section. System-prompt body + model /
// permission-mode / effort overrides. Pure presentation — state lives in
// the parent `PresetEditor` and propagates via `onPatch`.

import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { SettingsCard } from "@/components/settings/common/settings-section"
import { MODEL_PRESET_VALUES, PERMISSION_MODE_VALUES } from "@/lib/claude/model-presets"
import type { AppSettings, SendOptions } from "@/lib/claude/types"

import { EFFORT_LEVELS } from "./constants"
import type { PresetEditorState } from "../preset-editor-state"

export interface CapabilitySectionProps {
  state: PresetEditorState
  onPatch: (patch: Partial<PresetEditorState>) => void
  defaultOpen?: boolean
}

export function CapabilitySection({ state, onPatch, defaultOpen = true }: CapabilitySectionProps) {
  const t = useTranslations("presets")
  const tGeneral = useTranslations("settings.general")
  const tSection = useTranslations("presets.editor.sections.capability")

  const safeT = (k: string, fallback: string) => {
    const out = t(k as never)
    return out === `presets.${k}` || out === k ? fallback : out
  }

  return (
    <SettingsCard
      title={tSection("title")}
      description={tSection("description")}
      collapsible
      defaultOpen={defaultOpen}
    >
      <div className="space-y-1">
        <Label className="text-xs">{safeT("editor.systemPrompt", "System prompt")}</Label>
        <Textarea
          rows={8}
          value={state.content}
          onChange={(e) => onPatch({ content: e.target.value })}
          className="font-mono text-xs"
          placeholder={safeT("editor.systemPromptPlaceholder", "You are…")}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label className="text-xs">{safeT("editor.model", "Model")}</Label>
          <Select
            value={state.model || "__default__"}
            onValueChange={(v) => onPatch({ model: v === "__default__" ? "" : v })}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">
                {safeT("editor.useAppDefault", "Use app default")}
              </SelectItem>
              {MODEL_PRESET_VALUES.map((v) => (
                <SelectItem key={v} value={v}>
                  {tGeneral(`model.${v}` as `model.${typeof v}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            value={state.model}
            onChange={(e) => onPatch({ model: e.target.value })}
            placeholder={safeT("editor.customModelPlaceholder", "Or paste a model id")}
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{safeT("editor.permissionMode", "Permission mode")}</Label>
          <Select
            value={state.permissionMode ?? "__default__"}
            onValueChange={(v) =>
              onPatch({
                permissionMode:
                  v === "__default__" ? undefined : (v as AppSettings["permissionMode"]),
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">
                {safeT("editor.useAppDefault", "Use app default")}
              </SelectItem>
              {PERMISSION_MODE_VALUES.map((m) => (
                <SelectItem key={m} value={m}>
                  {tGeneral(`permission.${m}` as `permission.${typeof m}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{safeT("editor.effort", "Effort")}</Label>
          <Select
            value={state.effort ?? "__default__"}
            onValueChange={(v) =>
              onPatch({
                effort: v === "__default__" ? undefined : (v as SendOptions["effort"]),
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">
                {safeT("editor.useAppDefault", "Use app default")}
              </SelectItem>
              {EFFORT_LEVELS.map((m) => (
                <SelectItem key={m} value={m}>
                  {tGeneral(`effort.${m}` as `effort.${typeof m}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </SettingsCard>
  )
}
