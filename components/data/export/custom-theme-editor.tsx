"use client"

// Edit a `ThemeTokens` palette by token. Each color renders as a `<input
// type="color">` plus a hex text field. Saved themes live in
// `useCustomThemeStore` (localStorage-backed).

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Trash2Icon } from "lucide-react"
import { THEMES, THEME_LIST, type ThemeId, type ThemeTokens } from "@/lib/export/html/syntax-themes"
import { useCustomThemeStore, seedTokens, type CustomTheme } from "@/stores/theme"

const TOKEN_KEYS: Array<keyof ThemeTokens> = [
  "bg",
  "surface",
  "text",
  "muted",
  "border",
  "accent",
  "userBg",
  "assistantBg",
  "codeBg",
  "codeText",
  "detailBg",
]

interface Props {
  /** Active custom theme id, or null when editing a fresh draft. */
  selectedId: string | null
  /** Selected built-in theme id used for "seed from built-in" + previews. */
  builtInBase: ThemeId
  /** Called whenever the user picks/selects a saved theme. */
  onSelect: (id: string | null) => void
}

export function CustomThemeEditor({ selectedId, builtInBase, onSelect }: Props) {
  const t = useTranslations("export.theme")
  const themes = useCustomThemeStore((s) => s.themes)
  const upsert = useCustomThemeStore((s) => s.upsert)
  const remove = useCustomThemeStore((s) => s.remove)
  const selected = themes.find((th) => th.id === selectedId) ?? null
  const [draft, setDraft] = useState<ThemeTokens>(selected?.tokens ?? seedTokens(builtInBase))
  const [name, setName] = useState(selected?.name ?? "")

  const onSave = () => {
    if (!name.trim()) return
    const saved = upsert({
      id: selected?.id,
      name: name.trim(),
      tokens: draft,
    })
    onSelect(saved.id)
  }

  const onSeed = (id: ThemeId) => {
    setDraft({ ...THEMES[id] })
  }

  return (
    <Card className="space-y-3 p-3 text-sm">
      <div className="flex items-center justify-between">
        <Label>{t("customTitle")}</Label>
        {selected && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive"
            onClick={() => {
              remove(selected.id)
              onSelect(null)
              setName("")
              setDraft(seedTokens(builtInBase))
            }}
            aria-label={t("deleteTheme")}
          >
            <Trash2Icon className="size-4" />
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("namePlaceholder")}
          className="h-8 w-48"
        />
        <Button size="sm" onClick={onSave} disabled={!name.trim()}>
          {selected ? t("update") : t("saveNew")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">{t("seedFrom")}:</span>
        {THEME_LIST.map((th) => (
          <Button
            key={th.id}
            size="sm"
            variant="ghost"
            className="h-7 text-[11px]"
            onClick={() => onSeed(th.id)}
          >
            {th.label}
          </Button>
        ))}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {TOKEN_KEYS.map((key) => (
          <div key={key} className="flex items-center gap-2">
            <Label htmlFor={`tk-${key}`} className="w-24 text-[11px] uppercase tracking-wide">
              {key}
            </Label>
            <input
              id={`tk-${key}`}
              type="color"
              value={draft[key]}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent"
            />
            <Input
              value={draft[key]}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              className="h-7 w-28 font-mono text-[11px]"
            />
          </div>
        ))}
      </div>

      {themes.length > 0 && (
        <div className="space-y-1 border-t pt-2">
          <Label className="text-[11px]">{t("savedThemes")}</Label>
          <div className="flex flex-wrap gap-1.5">
            {themes.map((th) => (
              <SavedThemeChip
                key={th.id}
                theme={th}
                active={th.id === selectedId}
                onSelect={() => onSelect(th.id)}
              />
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}

function SavedThemeChip({
  theme,
  active,
  onSelect,
}: {
  theme: CustomTheme
  active: boolean
  onSelect: () => void
}) {
  return (
    <Button
      variant={active ? "default" : "outline"}
      size="sm"
      className="h-7 text-[11px]"
      onClick={onSelect}
    >
      <span
        className="mr-1 inline-block size-3 rounded-full border"
        style={{ background: theme.tokens.accent }}
      />
      {theme.name}
    </Button>
  )
}
