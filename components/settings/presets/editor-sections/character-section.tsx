"use client"

/**
 * Preset editor: Character (persona) section.
 *
 * Single-select picker over every character available to the subject:
 *   - Dexie-resident characters (host's library)
 *   - Plugin-contributed character-pack characters projected through
 *     `getPackCharacterByRuntimeId` from the `character-pack-registry`.
 *
 * The selected character id lands on `state.characterPackId`. When set,
 * the build-options pipeline projects that character's `systemPrompt` /
 * `model` / `mcpServerIds` etc. into the subject's `SendOptions`.
 *
 * Dexie reads are lazy (loaded on first open) so the section doesn't pay
 * a startup cost when never expanded.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SettingsCard } from "@/components/settings/common/settings-section"
import { listAllPackCharacters } from "@/lib/plugin/registries/character-pack-registry"
import { listCharacters } from "@/lib/db/characters"
import type { Character } from "@cognia/agent-config-types"

import type { PresetEditorState } from "../preset-editor-state"

export interface CharacterSectionProps {
  state: PresetEditorState
  onPatch: (patch: Partial<PresetEditorState>) => void
  defaultOpen?: boolean
  /**
   * Multi-select mode (team-level capability pool). When true the section
   * renders a checklist and reads/writes `selectedIds` / `onPatchMulti`
   * instead of the single-select `state.characterPackId`. Default false
   * preserves the PresetEditor single-character behavior.
   */
  multiple?: boolean
  selectedIds?: string[]
  onPatchMulti?: (ids: string[]) => void
}

interface CharacterRow {
  id: string
  name: string
  source: "dexie" | "pack"
  packName?: string
}

const NONE_VALUE = "__none__"

export function CharacterSection({
  state,
  onPatch,
  defaultOpen = false,
  multiple = false,
  selectedIds,
  onPatchMulti,
}: CharacterSectionProps) {
  const t = useTranslations("presets.editor.sections.character")
  const [rows, setRows] = useState<CharacterRow[]>([])
  const selectedSet = useMemo(() => new Set(selectedIds ?? []), [selectedIds])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const dexieChars: Character[] = await listCharacters().catch(() => [])
      if (cancelled) return
      const dexieRows: CharacterRow[] = dexieChars.map((c) => ({
        id: c.id,
        name: c.name,
        source: "dexie",
      }))
      const packRows: CharacterRow[] = listAllPackCharacters().map(
        ({ pack, character, pluginId }) => ({
          id: `cognia-pack:${pluginId ?? ""}:${pack.id}:${character.localId}`,
          name: character.name,
          source: "pack",
          packName: pack.name,
        })
      )
      setRows([...dexieRows, ...packRows])
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const current = state.characterPackId ?? NONE_VALUE

  const toggleMulti = (id: string, next: boolean): void => {
    const updated = new Set(selectedSet)
    if (next) updated.add(id)
    else updated.delete(id)
    onPatchMulti?.(Array.from(updated))
  }

  if (multiple) {
    return (
      <SettingsCard title={t("title")} description={t("description")} defaultOpen={defaultOpen}>
        <div className="space-y-2">
          {rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("inherit")}</p>
          ) : (
            rows.map((row) => (
              <label key={row.id} className="flex items-center gap-2 rounded-md border p-2 text-xs">
                <Checkbox
                  checked={selectedSet.has(row.id)}
                  onCheckedChange={(v) => toggleMulti(row.id, v === true)}
                />
                <span className="flex items-center gap-2">
                  <span>{row.name}</span>
                  {row.source === "pack" ? (
                    <Badge variant="secondary" className="text-[10px]">
                      {row.packName}
                    </Badge>
                  ) : null}
                </span>
              </label>
            ))
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
          onValueChange={(v) => onPatch({ characterPackId: v === NONE_VALUE ? undefined : v })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE_VALUE}>{t("inherit")}</SelectItem>
            {rows.map((row) => (
              <SelectItem key={row.id} value={row.id}>
                <span className="flex items-center gap-2">
                  <span>{row.name}</span>
                  {row.source === "pack" ? (
                    <Badge variant="secondary" className="text-[10px]">
                      {row.packName}
                    </Badge>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </SettingsCard>
  )
}
