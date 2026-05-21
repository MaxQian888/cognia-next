"use client"

// Font-family picker. Pulls the merged registry (web-safe + system + plugin)
// from `lib/appearance/font-registry.ts` via `useSyncExternalStore`, then
// renders a labelled Select with a per-source badge. Returns the selected
// family by calling `onChange`.

import { useMemo, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  fontRegistrySnapshot,
  subscribeFonts,
  type FontEntry,
} from "@/lib/appearance/font-registry"

const SOURCE_ORDER: Record<FontEntry["source"], number> = {
  websafe: 0,
  system: 1,
  plugin: 2,
}

const INHERIT_VALUE = "__inherit"

export interface FontFamilyPickerProps {
  /** Translation key for the label shown above the picker. */
  labelKey: string
  /** Currently selected family. Undefined ⇒ inherit (use defaults). */
  value: string | undefined
  /** Called with the family CSS string, or undefined for inherit. */
  onChange: (next: string | undefined) => void
  /** Optional hint shown under the picker. */
  hintKey?: string
  /** Pass `true` to filter to monospace-ish families (web-safe + plugin). */
  monoOnly?: boolean
}

export function FontFamilyPicker(props: FontFamilyPickerProps) {
  const t = useTranslations("settings.appearance.layoutType")
  // useSyncExternalStore lets us read the live registry snapshot without
  // bringing in Zustand for one piece of UI state. The cached snapshot in
  // font-registry keeps re-render churn down.
  const fonts = useSyncExternalStore(subscribeFonts, fontRegistrySnapshot, fontRegistrySnapshot)

  const filtered = useMemo(() => {
    const sorted = [...fonts].sort((a, b) => {
      const orderDelta = SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]
      if (orderDelta !== 0) return orderDelta
      return a.family.localeCompare(b.family)
    })
    if (!props.monoOnly) return sorted
    // Monospace filter heuristic: keep web-safe `monospace` / `ui-monospace`
    // / common known monospace plugin families. We can't reliably tell from
    // CSS family name alone, so this is a soft filter — system families are
    // always allowed since user knows what they installed.
    const monoKeywords = ["mono", "courier", "consolas", "fira"]
    return sorted.filter((entry) => {
      if (entry.source === "system") return true
      const lower = entry.family.toLowerCase()
      return monoKeywords.some((kw) => lower.includes(kw))
    })
  }, [fonts, props.monoOnly])

  const selectValue = props.value ?? INHERIT_VALUE

  return (
    <div className="space-y-1">
      <Label className="text-xs">{t(props.labelKey)}</Label>
      <Select
        value={selectValue}
        onValueChange={(value) => {
          if (value === INHERIT_VALUE) props.onChange(undefined)
          else props.onChange(value)
        }}
      >
        <SelectTrigger className="w-full max-w-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT_VALUE}>{t("font.inherit")}</SelectItem>
          {filtered.map((entry) => (
            <SelectItem
              key={`${entry.source}:${entry.family}:${entry.pluginId ?? ""}`}
              value={entry.family}
            >
              <span className="flex items-center justify-between gap-3">
                <span style={{ fontFamily: entry.family }}>{entry.label ?? entry.family}</span>
                <span className="text-[10px] uppercase text-muted-foreground">{entry.source}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {props.hintKey ? (
        <p className="text-[11px] text-muted-foreground">{t(props.hintKey)}</p>
      ) : null}
    </div>
  )
}
