"use client"

// Preset editor: Identity section. Icon emoji + color swatch + name +
// description + category. Wraps content in `SettingsCard` so the user can
// fold the section. Pure presentation — state lives in the parent
// `PresetEditor` and propagates via `onPatch`.

import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SettingsCard } from "@/components/settings/common/settings-section"
import { PRESET_CATEGORIES } from "@/lib/presets/categories"
import type { PresetCategory } from "@cognia/agent-config-types"

import { COLOR_PALETTE } from "./constants"
import type { PresetEditorState } from "../preset-editor-state"

export interface IdentitySectionProps {
  state: PresetEditorState
  onPatch: (patch: Partial<PresetEditorState>) => void
  defaultOpen?: boolean
}

export function IdentitySection({ state, onPatch, defaultOpen = true }: IdentitySectionProps) {
  const t = useTranslations("presets")
  const tCategory = useTranslations("presets.category")
  const tSection = useTranslations("presets.editor.sections.identity")

  const safeT = (k: string, fallback: string) => {
    const out = t(k as never)
    return out === `presets.${k}` || out === k ? fallback : out
  }
  const safeTCategory = (k: string, fallback: string) => {
    const out = tCategory(k as never)
    return out === `presets.category.${k}` || out === k ? fallback : out
  }

  return (
    <SettingsCard
      title={tSection("title")}
      description={tSection("description")}
      collapsible
      defaultOpen={defaultOpen}
    >
      <div className="grid grid-cols-[auto_1fr] gap-3">
        <div className="flex flex-col items-center gap-2">
          <span
            className="flex size-12 items-center justify-center rounded-full text-lg"
            style={{ backgroundColor: state.color || COLOR_PALETTE[0], color: "white" }}
            aria-hidden
          >
            {state.icon?.trim() || state.name.slice(0, 1).toUpperCase() || "?"}
          </span>
          <Input
            value={state.icon}
            onChange={(e) => onPatch({ icon: e.target.value })}
            placeholder="✨"
            className="h-7 w-12 text-center"
            maxLength={4}
            aria-label={safeT("editor.icon", "Icon emoji")}
          />
          <div className="grid grid-cols-4 gap-1">
            {COLOR_PALETTE.map((c) => (
              <Button
                key={c}
                type="button"
                variant="outline"
                size="icon"
                onClick={() => onPatch({ color: c })}
                className="size-4 rounded-full p-0 ring-1 ring-border"
                style={{
                  backgroundColor: c,
                  outline: state.color === c ? "2px solid var(--ring)" : undefined,
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
              value={state.name}
              onChange={(e) => onPatch({ name: e.target.value })}
              placeholder={safeT("editor.namePlaceholder", "Code Reviewer")}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{safeT("editor.description", "Description")}</Label>
            <Input
              value={state.description}
              onChange={(e) => onPatch({ description: e.target.value })}
              placeholder={safeT("editor.descriptionPlaceholder", "(optional) one-line summary")}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{safeT("editor.category", "Category")}</Label>
            <Select
              value={state.category || "__none__"}
              onValueChange={(v) =>
                onPatch({ category: v === "__none__" ? "" : (v as PresetCategory) })
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
    </SettingsCard>
  )
}
