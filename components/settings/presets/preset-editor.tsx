"use client"

// Preset editor — orchestrator. Each form section is a separate file under
// `editor-sections/` (Identity / Capability / Tools / Advanced) and wraps
// itself in a collapsible `SettingsCard`. This file owns the
// `PresetEditorState`, handles `initial` rehydration, validates on submit,
// and renders the section files in order plus the footer.
//
// `PresetEditorState`, `PresetEditorOutput`, `emptyEditorState`, and
// `presetToEditorState` live in `preset-editor-state.ts` and are re-exported
// here so existing imports (`prompt-presets-section.tsx`) keep working.

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import type { McpServer, Skill } from "@/lib/claude/types"

import { IdentitySection } from "./editor-sections/identity-section"
import { CapabilitySection } from "./editor-sections/capability-section"
import { ToolsSection } from "./editor-sections/tools-section"
import { AdvancedSection } from "./editor-sections/advanced-section"
import {
  emptyEditorState,
  type PresetEditorOutput,
  type PresetEditorState,
} from "./preset-editor-state"

export {
  emptyEditorState,
  presetToEditorState,
  type PresetEditorOutput,
  type PresetEditorState,
} from "./preset-editor-state"

interface Props {
  initial?: PresetEditorState
  skillsCatalog: Skill[]
  mcpCatalog: McpServer[]
  submitLabel?: string
  onCancel: () => void
  onSave: (output: PresetEditorOutput) => Promise<void>
}

export function PresetEditor({
  initial,
  skillsCatalog,
  mcpCatalog,
  submitLabel,
  onCancel,
  onSave,
}: Props) {
  const t = useTranslations("presets")
  const safeT = (k: string, fallback: string) => {
    const out = t(k as never)
    return out === `presets.${k}` || out === k ? fallback : out
  }

  const [state, setState] = useState<PresetEditorState>(initial ?? emptyEditorState())
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setState(initial ?? emptyEditorState())
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [initial])

  const onPatch = useCallback((patch: Partial<PresetEditorState>) => {
    setState((prev) => ({ ...prev, ...patch }))
  }, [])

  const submit = async () => {
    if (!state.name.trim()) {
      toast.error(safeT("validation.nameRequired", "Preset name is required."))
      return
    }
    if (!state.content.trim()) {
      toast.error(safeT("validation.contentRequired", "System prompt cannot be empty."))
      return
    }
    setSaving(true)
    try {
      await onSave({
        name: state.name.trim(),
        description: state.description.trim() || undefined,
        icon: state.icon.trim() || undefined,
        color: state.color || undefined,
        category: state.category || undefined,
        content: state.content,
        model: state.model.trim() || undefined,
        permissionMode: state.permissionMode,
        effort: state.effort,
        allowedTools: state.allowedTools.length > 0 ? state.allowedTools : undefined,
        disallowedTools: state.disallowedTools.length > 0 ? state.disallowedTools : undefined,
        mcpServerIds: state.mcpServerIds,
        skillIds: state.skillIds.length > 0 ? state.skillIds : undefined,
        agentModeId: state.agentModeId || undefined,
        workingDir: state.workingDir.trim() || undefined,
        isDefault: state.isDefault,
        isFavorite: state.isFavorite,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <IdentitySection state={state} onPatch={onPatch} />
      <CapabilitySection state={state} onPatch={onPatch} />
      <ToolsSection
        state={state}
        onPatch={onPatch}
        skillsCatalog={skillsCatalog}
        mcpCatalog={mcpCatalog}
      />
      <AdvancedSection state={state} onPatch={onPatch} />

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {safeT("actions.cancel", "Cancel")}
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={saving}>
          {saving
            ? safeT("editor.saving", "Saving…")
            : (submitLabel ?? safeT("actions.save", "Save"))}
        </Button>
      </div>
    </div>
  )
}
