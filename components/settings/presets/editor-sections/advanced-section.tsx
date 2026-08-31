"use client"

// Preset editor: Advanced section. Working directory + agent-mode override +
// `isDefault` / `isFavorite` flags. Defaults to collapsed since most users
// never touch these (especially the working-directory Tauri-only field).

import { useTranslations } from "next-intl"
import { FolderOpenIcon } from "lucide-react"
import { useDirectoryPicker } from "@/hooks/files/use-directory-picker"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SettingsCard } from "@/components/settings/common/settings-section"
import { BUILT_IN_AGENT_MODES } from "@/types/agent/agent-mode"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"

import type { PresetEditorState } from "../preset-editor-state"

export interface AdvancedSectionProps {
  state: PresetEditorState
  onPatch: (patch: Partial<PresetEditorState>) => void
  defaultOpen?: boolean
}

export function AdvancedSection({ state, onPatch, defaultOpen = false }: AdvancedSectionProps) {
  const t = useTranslations("presets")
  const tSection = useTranslations("presets.editor.sections.advanced")

  const safeT = (k: string, fallback: string) => {
    const out = t(k as never)
    return out === `presets.${k}` || out === k ? fallback : out
  }

  const customModes = useCustomModeStore((s) => s.customModes)
  const customModeList = Object.values(customModes)

  // A preset's working directory is a plain path the caller types or picks. It
  // is deliberately NOT browsed against a paired host: a preset outlives the
  // host that was active when it was saved, so a path chosen there could name
  // nothing on the machine that later runs it.
  const directoryPicker = useDirectoryPicker({
    title: safeT("pickWorkingDir", "Select working directory"),
  })
  const handlePickDir = async () => {
    try {
      const picked = await directoryPicker.browse()
      if (picked) onPatch({ workingDir: picked })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <SettingsCard
      title={tSection("title")}
      description={tSection("description")}
      collapsible
      defaultOpen={defaultOpen}
    >
      <div className="space-y-1">
        <Label className="text-xs">{safeT("editor.workingDir", "Working directory")}</Label>
        <div className="flex gap-2">
          <Input
            value={state.workingDir}
            onChange={(e) => onPatch({ workingDir: e.target.value })}
            placeholder={safeT("editor.workingDirPlaceholder", "/path/to/project (optional)")}
            className="font-mono text-xs"
          />
          {/* Absent rather than disabled: the input beside it is the control
              where no picker exists, so a permanently-dead button would only
              add noise. */}
          {directoryPicker.available && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => void handlePickDir()}
              disabled={directoryPicker.busy}
              aria-label={safeT("editor.pickWorkingDir", "Pick directory")}
            >
              <FolderOpenIcon className="size-4" />
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{safeT("editor.agentMode", "Agent mode")}</Label>
        <Select
          value={state.agentModeId || "__none__"}
          onValueChange={(v) => onPatch({ agentModeId: v === "__none__" ? "" : v })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">
              {safeT("editor.useAppDefault", "Use whichever mode is active")}
            </SelectItem>
            {BUILT_IN_AGENT_MODES.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
            {customModeList.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
          <span>
            <span className="block">{safeT("editor.setDefault", "Set as default")}</span>
            <span className="text-[11px] text-muted-foreground">
              {safeT("editor.setDefaultHelp", "Auto-applied to new sessions without a character.")}
            </span>
          </span>
          <Switch
            checked={state.isDefault}
            onCheckedChange={(checked) => onPatch({ isDefault: checked })}
          />
        </label>
        <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
          <span>
            <span className="block">{safeT("editor.favorite", "Favorite")}</span>
            <span className="text-[11px] text-muted-foreground">
              {safeT("editor.favoriteHelp", "Pinned to the top of your library.")}
            </span>
          </span>
          <Switch
            checked={state.isFavorite}
            onCheckedChange={(checked) => onPatch({ isFavorite: checked })}
          />
        </label>
      </div>
    </SettingsCard>
  )
}
