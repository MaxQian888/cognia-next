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
  /** Pass `true` to show only monospace families (terminal font picker). */
  monoOnly?: boolean
  /**
   * i18n namespace for `labelKey` / `hintKey`. Defaults to the appearance
   * tab's namespace; the terminal card passes its own. The "inherit" option
   * label is always resolved from the appearance namespace.
   */
  namespace?: string
}

export function FontFamilyPicker(props: FontFamilyPickerProps) {
  const t = useTranslations(props.namespace ?? "settings.appearance.layoutType")
  // The "inherit" label lives in the appearance namespace regardless of which
  // caller's namespace owns labelKey/hintKey.
  const tShared = useTranslations("settings.appearance.layoutType")
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
    // System families carry a real fixed-pitch flag from `os_list_fonts`, so
    // trust it. Web-safe / plugin families (and any system entry missing the
    // flag — e.g. older data) fall back to a name heuristic, since the CSS
    // family name is all we have for those.
    const monoKeywords = ["mono", "courier", "consolas", "fira", "menlo", "consol"]
    return sorted.filter((entry) => {
      if (entry.source === "system" && typeof entry.monospaced === "boolean") {
        return entry.monospaced
      }
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
          <SelectItem value={INHERIT_VALUE}>{tShared("font.inherit")}</SelectItem>
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
