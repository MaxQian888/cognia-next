"use client"

/**
 * Preset editor: Native Anthropic Tools section.
 *
 * Surfaces every plugin-contributed native Anthropic tool (computer_*,
 * bash_*, text_editor_*) via the `native-anthropic-tool-registry` overlay
 * as checkboxes the subject can opt into. Selected ids land on
 * `state.nativeAnthropicToolIds`. Rendered only when the consumer wires it
 * in via `<PresetEditor extraSections={...} />` (TeammateConfigDialog).
 *
 * Permissions: tools requiring `native:input` / `native:screen` (computer
 * use) are subject to `permission-guard` enforcement at runtime; this UI
 * surfaces the requirement note next to the row but doesn't pre-block.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { SettingsCard } from "@/components/settings/common/settings-section"
import { listNativeAnthropicToolEntries } from "@/lib/plugin/registries/native-anthropic-tool-registry"

import type { PresetEditorState } from "../preset-editor-state"

export interface NativeToolsSectionProps {
  state: PresetEditorState
  onPatch: (patch: Partial<PresetEditorState>) => void
  defaultOpen?: boolean
}

export function NativeToolsSection({
  state,
  onPatch,
  defaultOpen = false,
}: NativeToolsSectionProps) {
  const t = useTranslations("presets.editor.sections.nativeTools")

  const entries = useMemo(() => listNativeAnthropicToolEntries(), [])
  const selected = useMemo(
    () => new Set(state.nativeAnthropicToolIds ?? []),
    [state.nativeAnthropicToolIds]
  )

  const toggle = (id: string, next: boolean): void => {
    const updated = new Set(selected)
    if (next) updated.add(id)
    else updated.delete(id)
    const next_ = Array.from(updated)
    onPatch({ nativeAnthropicToolIds: next_.length > 0 ? next_ : undefined })
  }

  return (
    <SettingsCard title={t("title")} description={t("description")} defaultOpen={defaultOpen}>
      <div className="space-y-2">
        {entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          entries.map(({ id, entry, pluginId }) => (
            <label key={id} className="flex items-start gap-2 rounded-md border p-2 text-xs">
              <Checkbox
                checked={selected.has(id)}
                onCheckedChange={(v) => toggle(id, v === true)}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <div className="flex items-center gap-2">
                  <Label className="text-xs font-medium">{entry.name}</Label>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {entry.type}
                  </Badge>
                  {pluginId ? (
                    <Badge variant="secondary" className="text-[10px]">
                      {pluginId}
                    </Badge>
                  ) : null}
                </div>
                {entry.type === "computer_20251124" ? (
                  <p className="text-[10px] text-muted-foreground">
                    {t("requiresNativeInputPermission")}
                  </p>
                ) : null}
              </div>
            </label>
          ))
        )}
      </div>
    </SettingsCard>
  )
}
