"use client"

/**
 * Preset editor: Subagent section.
 *
 * Multi-select picker over the union of the 4 host-bundled subagents
 * (workflow-designer / workflow-debugger / workflow-refactorer /
 * workflow-doc-writer) and every plugin-registered subagent surfaced
 * through `resolveAllSubagents({ context: "team" })`. Selected ids land
 * on `state.subagentIds` and flow into Claude SDK `SendOptions.agents`
 * via `build-options.ts`.
 */

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { SettingsCard } from "@/components/settings/common/settings-section"
import { resolveAllSubagents } from "@/lib/claude/agents/subagents"

import type { PresetEditorState } from "../preset-editor-state"

export interface SubagentSectionProps {
  state: PresetEditorState
  onPatch: (patch: Partial<PresetEditorState>) => void
  defaultOpen?: boolean
}

export function SubagentSection({ state, onPatch, defaultOpen = false }: SubagentSectionProps) {
  const t = useTranslations("presets.editor.sections.subagent")
  const subagents = useMemo(() => resolveAllSubagents({ context: "team" }), [])

  const selected = useMemo(() => new Set(state.subagentIds ?? []), [state.subagentIds])

  const toggle = (id: string, next: boolean): void => {
    const updated = new Set(selected)
    if (next) updated.add(id)
    else updated.delete(id)
    const arr = Array.from(updated)
    onPatch({ subagentIds: arr.length > 0 ? arr : undefined })
  }

  const ids = Object.keys(subagents)

  return (
    <SettingsCard title={t("title")} description={t("description")} defaultOpen={defaultOpen}>
      <div className="space-y-2">
        {ids.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          ids.map((id) => {
            const def = subagents[id] as { description?: string }
            const isPluginScoped = id.includes(":")
            return (
              <label key={id} className="flex items-start gap-2 rounded-md border p-2 text-xs">
                <Checkbox
                  checked={selected.has(id)}
                  onCheckedChange={(v) => toggle(id, v === true)}
                  className="mt-0.5"
                />
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <Label className="font-mono text-xs">{id}</Label>
                    {isPluginScoped ? (
                      <Badge variant="secondary" className="text-[10px]">
                        {t("pluginBadge")}
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">
                        {t("builtinBadge")}
                      </Badge>
                    )}
                  </div>
                  {def.description ? (
                    <p className="text-[10px] text-muted-foreground">{def.description}</p>
                  ) : null}
                </div>
              </label>
            )
          })
        )}
      </div>
    </SettingsCard>
  )
}
