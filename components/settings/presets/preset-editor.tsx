"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { FolderOpenIcon } from "lucide-react"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"
import { isTauri } from "@/lib/tauri"
import type {
  AppSettings,
  McpServer,
  PresetCategory,
  SendOptions,
  Skill,
  SystemPromptPreset,
} from "@/lib/claude/types"
import { PRESET_CATEGORIES } from "@/lib/presets/categories"
import { BUILT_IN_AGENT_MODES } from "@/types/agent/agent-mode"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { MODEL_PRESET_VALUES, PERMISSION_MODE_VALUES } from "@/lib/claude/model-presets"

const EFFORT_LEVELS: NonNullable<SendOptions["effort"]>[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]

const COLOR_PALETTE = [
  "oklch(0.65 0.18 245)",
  "oklch(0.7 0.15 30)",
  "oklch(0.7 0.13 150)",
  "oklch(0.78 0.16 90)",
  "oklch(0.7 0.14 320)",
  "oklch(0.7 0.16 200)",
  "oklch(0.65 0.18 350)",
  "oklch(0.7 0.14 60)",
  "oklch(0.72 0.13 280)",
  "oklch(0.7 0.16 165)",
  "oklch(0.7 0.1 250)",
  "oklch(0.65 0.15 220)",
]

export interface PresetEditorState {
  name: string
  description: string
  icon: string
  color: string
  category: PresetCategory | ""
  content: string
  model: string
  permissionMode: AppSettings["permissionMode"]
  effort: SendOptions["effort"]
  allowedTools: string[]
  disallowedTools: string[]
  mcpServerIds: string[] | undefined
  skillIds: string[]
  agentModeId: string
  workingDir: string
  isDefault: boolean
  isFavorite: boolean
}

export type PresetEditorOutput = Omit<
  Partial<SystemPromptPreset>,
  "id" | "createdAt" | "updatedAt" | "isBuiltIn" | "usageCount" | "lastUsedAt" | "sortOrder"
> & {
  /** Required on save. */
  name: string
  content: string
}

interface Props {
  initial?: PresetEditorState
  skillsCatalog: Skill[]
  mcpCatalog: McpServer[]
  submitLabel?: string
  onCancel: () => void
  onSave: (output: PresetEditorOutput) => Promise<void>
}

export function emptyEditorState(): PresetEditorState {
  return {
    name: "",
    description: "",
    icon: "✨",
    color: COLOR_PALETTE[0],
    category: "",
    content: "",
    model: "",
    permissionMode: undefined,
    effort: undefined,
    allowedTools: [],
    disallowedTools: [],
    mcpServerIds: undefined,
    skillIds: [],
    agentModeId: "",
    workingDir: "",
    isDefault: false,
    isFavorite: false,
  }
}

export function presetToEditorState(preset: SystemPromptPreset): PresetEditorState {
  return {
    name: preset.name,
    description: preset.description ?? "",
    icon: preset.icon ?? "✨",
    color: preset.color ?? COLOR_PALETTE[0],
    category: preset.category ?? "",
    content: preset.content,
    model: preset.model ?? "",
    permissionMode: preset.permissionMode,
    effort: preset.effort,
    allowedTools: preset.allowedTools ?? [],
    disallowedTools: preset.disallowedTools ?? [],
    mcpServerIds: preset.mcpServerIds,
    skillIds: preset.skillIds ?? [],
    agentModeId: preset.agentModeId ?? "",
    workingDir: preset.workingDir ?? "",
    isDefault: preset.isDefault === true,
    isFavorite: preset.isFavorite === true,
  }
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
  const tCategory = useTranslations("presets.category")
  const tGeneral = useTranslations("settings.general")
  const safeT = (k: string, fallback: string) => {
    const out = t(k as never)
    return out === `presets.${k}` || out === k ? fallback : out
  }
  const safeTCategory = (k: string, fallback: string) => {
    const out = tCategory(k as never)
    return out === `presets.category.${k}` || out === k ? fallback : out
  }

  const customModes = useCustomModeStore((s) => s.customModes)

  const [s, setS] = useState<PresetEditorState>(initial ?? emptyEditorState())
  const [allowToolsText, setAllowToolsText] = useState((initial?.allowedTools ?? []).join(", "))
  const [denyToolsText, setDenyToolsText] = useState((initial?.disallowedTools ?? []).join(", "))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    const next = initial ?? emptyEditorState()
    setS(next)
    setAllowToolsText(next.allowedTools.join(", "))
    setDenyToolsText(next.disallowedTools.join(", "))
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [initial])

  const handlePickDir = async () => {
    if (!isTauri()) return
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: safeT("pickWorkingDir", "Select working directory"),
      })
      if (typeof picked === "string") setS({ ...s, workingDir: picked })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const submit = async () => {
    if (!s.name.trim()) {
      toast.error(safeT("validation.nameRequired", "Preset name is required."))
      return
    }
    if (!s.content.trim()) {
      toast.error(safeT("validation.contentRequired", "System prompt cannot be empty."))
      return
    }
    setSaving(true)
    try {
      const allowed = parseChips(allowToolsText)
      const disallowed = parseChips(denyToolsText)
      await onSave({
        name: s.name.trim(),
        description: s.description.trim() || undefined,
        icon: s.icon.trim() || undefined,
        color: s.color || undefined,
        category: s.category || undefined,
        content: s.content,
        model: s.model.trim() || undefined,
        permissionMode: s.permissionMode,
        effort: s.effort,
        allowedTools: allowed.length > 0 ? allowed : undefined,
        disallowedTools: disallowed.length > 0 ? disallowed : undefined,
        mcpServerIds: s.mcpServerIds,
        skillIds: s.skillIds.length > 0 ? s.skillIds : undefined,
        agentModeId: s.agentModeId || undefined,
        workingDir: s.workingDir.trim() || undefined,
        isDefault: s.isDefault,
        isFavorite: s.isFavorite,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  const customModeList = Object.values(customModes)

  return (
    <Card className="space-y-4 p-4">
      {/* --- Identity row: icon + name + description ----------------- */}
      <div className="grid grid-cols-[auto_1fr] gap-3">
        <div className="flex flex-col items-center gap-2">
          <span
            className="flex size-12 items-center justify-center rounded-full text-lg"
            style={{ backgroundColor: s.color || COLOR_PALETTE[0], color: "white" }}
            aria-hidden
          >
            {s.icon?.trim() || s.name.slice(0, 1).toUpperCase() || "?"}
          </span>
          <Input
            value={s.icon}
            onChange={(e) => setS({ ...s, icon: e.target.value })}
            placeholder="✨"
            className="h-7 w-12 text-center"
            maxLength={4}
            aria-label={safeT("editor.icon", "Icon emoji")}
          />
          <div className="grid grid-cols-4 gap-1">
            {COLOR_PALETTE.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setS({ ...s, color: c })}
                className="size-4 rounded-full ring-1 ring-border"
                style={{
                  backgroundColor: c,
                  outline: s.color === c ? "2px solid var(--ring)" : undefined,
                  outlineOffset: 2,
                }}
                aria-label={`${safeT("editor.pickColor", "Pick color")} ${c}`}
              />
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <div className="space-y-1">
            <Label className="text-xs">{safeT("editor.name", "Name")}</Label>
            <Input
              value={s.name}
              onChange={(e) => setS({ ...s, name: e.target.value })}
              placeholder={safeT("editor.namePlaceholder", "Code Reviewer")}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{safeT("editor.description", "Description")}</Label>
            <Input
              value={s.description}
              onChange={(e) => setS({ ...s, description: e.target.value })}
              placeholder={safeT("editor.descriptionPlaceholder", "(optional) one-line summary")}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{safeT("editor.category", "Category")}</Label>
            <Select
              value={s.category || "__none__"}
              onValueChange={(v) =>
                setS({ ...s, category: v === "__none__" ? "" : (v as PresetCategory) })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">
                  {safeT("editor.uncategorized", "Uncategorized")}
                </SelectItem>
                {PRESET_CATEGORIES.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {safeTCategory(c.labelKey, c.id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* --- System prompt body --------------------------------------- */}
      <div className="space-y-1">
        <Label className="text-xs">{safeT("editor.systemPrompt", "System prompt")}</Label>
        <Textarea
          rows={8}
          value={s.content}
          onChange={(e) => setS({ ...s, content: e.target.value })}
          className="font-mono text-xs"
          placeholder={safeT("editor.systemPromptPlaceholder", "You are…")}
        />
      </div>

      {/* --- Override row: model + permission + effort --------------- */}
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">{safeT("editor.model", "Model")}</Label>
          <Select
            value={s.model || "__default__"}
            onValueChange={(v) => setS({ ...s, model: v === "__default__" ? "" : v })}
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
            value={s.model}
            onChange={(e) => setS({ ...s, model: e.target.value })}
            placeholder={safeT("editor.customModelPlaceholder", "Or paste a model id")}
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{safeT("editor.permissionMode", "Permission mode")}</Label>
          <Select
            value={s.permissionMode ?? "__default__"}
            onValueChange={(v) =>
              setS({
                ...s,
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
            value={s.effort ?? "__default__"}
            onValueChange={(v) =>
              setS({
                ...s,
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

      {/* --- Tool whitelists ---------------------------------------- */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">
            {safeT("editor.allowedTools", "Allowed tools (comma-separated)")}
          </Label>
          <Input
            value={allowToolsText}
            onChange={(e) => setAllowToolsText(e.target.value)}
            placeholder="Bash, Read, WebSearch"
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">
            {safeT("editor.disallowedTools", "Disallowed tools (comma-separated)")}
          </Label>
          <Input
            value={denyToolsText}
            onChange={(e) => setDenyToolsText(e.target.value)}
            placeholder="Bash"
            className="font-mono text-xs"
          />
        </div>
      </div>

      {/* --- Working directory -------------------------------------- */}
      <div className="space-y-1">
        <Label className="text-xs">{safeT("editor.workingDir", "Working directory")}</Label>
        <div className="flex gap-2">
          <Input
            value={s.workingDir}
            onChange={(e) => setS({ ...s, workingDir: e.target.value })}
            placeholder={safeT("editor.workingDirPlaceholder", "/path/to/project (optional)")}
            className="font-mono text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={handlePickDir}
            disabled={!isTauri()}
            aria-label={safeT("editor.pickWorkingDir", "Pick directory")}
          >
            <FolderOpenIcon className="size-4" />
          </Button>
        </div>
      </div>

      {/* --- Skills + MCP subset ----------------------------------- */}
      <ItemMultiSelect
        label={safeT("editor.skills", "Skills")}
        helpText={safeT(
          "editor.skillsHelp",
          "Order matters — earlier skills are appended first to the system prompt."
        )}
        items={skillsCatalog.map((sk) => ({
          id: sk.id,
          name: sk.name,
          description: sk.description,
        }))}
        selectedIds={s.skillIds}
        onChange={(ids) => setS({ ...s, skillIds: ids })}
        emptyHint={safeT("editor.skillsEmptyHint", "(no skills selected)")}
      />

      <ItemMultiSelect
        label={safeT("editor.mcpServers", "MCP servers")}
        helpText={safeT(
          "editor.mcpServersHelp",
          'Leave all unselected to mean "use every enabled server".'
        )}
        items={mcpCatalog.map((m) => ({
          id: m.id,
          name: m.name,
          description: `${m.transport}${m.enabled ? "" : " — disabled"}`,
        }))}
        selectedIds={s.mcpServerIds ?? []}
        allowEmpty
        emptyHint={safeT("editor.mcpServersEmptyHint", "(uses all enabled MCP servers)")}
        onChange={(ids) => setS({ ...s, mcpServerIds: ids.length > 0 ? ids : undefined })}
      />

      {/* --- Agent mode override ----------------------------------- */}
      <div className="space-y-1">
        <Label className="text-xs">{safeT("editor.agentMode", "Agent mode")}</Label>
        <Select
          value={s.agentModeId || "__none__"}
          onValueChange={(v) => setS({ ...s, agentModeId: v === "__none__" ? "" : v })}
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

      {/* --- Flags row -------------------------------------------- */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
          <span>
            <span className="block">{safeT("editor.setDefault", "Set as default")}</span>
            <span className="text-[11px] text-muted-foreground">
              {safeT("editor.setDefaultHelp", "Auto-applied to new sessions without a character.")}
            </span>
          </span>
          <Switch
            checked={s.isDefault}
            onCheckedChange={(checked) => setS({ ...s, isDefault: checked })}
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
            checked={s.isFavorite}
            onCheckedChange={(checked) => setS({ ...s, isFavorite: checked })}
          />
        </label>
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {safeT("actions.cancel", "Cancel")}
        </Button>
        <Button size="sm" onClick={submit} disabled={saving}>
          {saving
            ? safeT("editor.saving", "Saving…")
            : (submitLabel ?? safeT("actions.save", "Save"))}
        </Button>
      </div>
    </Card>
  )
}

function parseChips(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

interface MultiSelectProps {
  label: string
  helpText?: string
  items: Array<{ id: string; name: string; description?: string }>
  selectedIds: string[]
  onChange: (ids: string[]) => void
  allowEmpty?: boolean
  emptyHint?: string
}

function ItemMultiSelect({
  label,
  helpText,
  items,
  selectedIds,
  onChange,
  allowEmpty,
  emptyHint,
}: MultiSelectProps) {
  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id))
    } else {
      onChange([...selectedIds, id])
    }
  }

  const move = (id: string, dir: -1 | 1) => {
    const idx = selectedIds.indexOf(id)
    if (idx < 0) return
    const target = idx + dir
    if (target < 0 || target >= selectedIds.length) return
    const next = [...selectedIds]
    ;[next[idx], next[target]] = [next[target], next[idx]]
    onChange(next)
  }

  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {helpText && <p className="text-[11px] text-muted-foreground">{helpText}</p>}
      {selectedIds.length === 0 && allowEmpty && emptyHint && (
        <p className="text-[11px] italic text-muted-foreground">{emptyHint}</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {items.length === 0 ? (
          <p className="text-[11px] italic text-muted-foreground">(none defined yet)</p>
        ) : (
          items.map((it) => {
            const active = selectedIds.includes(it.id)
            const order = active ? selectedIds.indexOf(it.id) + 1 : null
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => toggle(it.id)}
                className={
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors " +
                  (active
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-muted/30 text-muted-foreground hover:bg-muted")
                }
                title={it.description}
              >
                {order !== null && (
                  <span className="font-mono text-[10px] text-muted-foreground">#{order}</span>
                )}
                {it.name}
              </button>
            )
          })
        )}
      </div>
      {selectedIds.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="text-[11px] text-muted-foreground">Reorder:</span>
          {selectedIds.map((id) => {
            const it = items.find((x) => x.id === id)
            if (!it) return null
            return (
              <span
                key={id}
                className="inline-flex items-center gap-0.5 rounded border bg-background px-1 text-[11px]"
              >
                {it.name}
                <button
                  type="button"
                  onClick={() => move(id, -1)}
                  className="px-1 text-muted-foreground hover:text-foreground"
                  aria-label={`Move ${it.name} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  onClick={() => move(id, 1)}
                  className="px-1 text-muted-foreground hover:text-foreground"
                  aria-label={`Move ${it.name} down`}
                >
                  ↓
                </button>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
