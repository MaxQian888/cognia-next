"use client"

// Preset editor: Tools section. Allowed/disallowed tool whitelists + skill
// stack (ordered) + MCP server subset. Owns the local text state for the
// comma-separated tool inputs and parses to arrays on every change so the
// parent `PresetEditor` always reads canonical `string[]` arrays from
// `state.allowedTools` / `state.disallowedTools` at submit time.

import { useState } from "react"
import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { SettingsCard } from "@/components/settings/common/settings-section"
import type { McpServer, Skill } from "@/lib/claude/types"

import type { PresetEditorState } from "../preset-editor-state"

export interface ToolsSectionProps {
  state: PresetEditorState
  onPatch: (patch: Partial<PresetEditorState>) => void
  skillsCatalog: Skill[]
  mcpCatalog: McpServer[]
  defaultOpen?: boolean
}

export function ToolsSection({
  state,
  onPatch,
  skillsCatalog,
  mcpCatalog,
  defaultOpen = true,
}: ToolsSectionProps) {
  const t = useTranslations("presets")
  const tSection = useTranslations("presets.editor.sections.tools")

  const safeT = (k: string, fallback: string) => {
    const out = t(k as never)
    return out === `presets.${k}` || out === k ? fallback : out
  }

  // Local text state hydrates from parent state.allowedTools once per
  // parent-driven reset. The parent signals a reset by replacing the
  // `state.allowedTools` array reference on `initial` change; we mirror the
  // previous reference in state and re-hydrate the text only on that
  // transition, not on every onPatch round-trip. Derived during render per
  // React 19 guidance — calling setState in an effect for prop-mirroring
  // trips react-hooks/set-state-in-effect.
  const [allowText, setAllowText] = useState(() => state.allowedTools.join(", "))
  const [denyText, setDenyText] = useState(() => state.disallowedTools.join(", "))
  const [lastAllowedSource, setLastAllowedSource] = useState(state.allowedTools)
  const [lastDisallowedSource, setLastDisallowedSource] = useState(state.disallowedTools)

  if (lastAllowedSource !== state.allowedTools) {
    const parsed = parseChips(allowText)
    const same =
      parsed.length === state.allowedTools.length &&
      parsed.every((v, i) => v === state.allowedTools[i])
    setLastAllowedSource(state.allowedTools)
    if (!same) setAllowText(state.allowedTools.join(", "))
  }
  if (lastDisallowedSource !== state.disallowedTools) {
    const parsed = parseChips(denyText)
    const same =
      parsed.length === state.disallowedTools.length &&
      parsed.every((v, i) => v === state.disallowedTools[i])
    setLastDisallowedSource(state.disallowedTools)
    if (!same) setDenyText(state.disallowedTools.join(", "))
  }

  const handleAllowChange = (next: string) => {
    setAllowText(next)
    onPatch({ allowedTools: parseChips(next) })
  }
  const handleDenyChange = (next: string) => {
    setDenyText(next)
    onPatch({ disallowedTools: parseChips(next) })
  }

  return (
    <SettingsCard
      title={tSection("title")}
      description={tSection("description")}
      collapsible
      defaultOpen={defaultOpen}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">
            {safeT("editor.allowedTools", "Allowed tools (comma-separated)")}
          </Label>
          <Input
            value={allowText}
            onChange={(e) => handleAllowChange(e.target.value)}
            placeholder="Bash, Read, WebSearch"
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">
            {safeT("editor.disallowedTools", "Disallowed tools (comma-separated)")}
          </Label>
          <Input
            value={denyText}
            onChange={(e) => handleDenyChange(e.target.value)}
            placeholder="Bash"
            className="font-mono text-xs"
          />
        </div>
      </div>

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
        selectedIds={state.skillIds}
        onChange={(ids) => onPatch({ skillIds: ids })}
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
        selectedIds={state.mcpServerIds ?? []}
        allowEmpty
        emptyHint={safeT("editor.mcpServersEmptyHint", "(uses all enabled MCP servers)")}
        onChange={(ids) => onPatch({ mcpServerIds: ids.length > 0 ? ids : undefined })}
      />
    </SettingsCard>
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
