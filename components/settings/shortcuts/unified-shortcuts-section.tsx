"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { KeyboardIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ShortcutsSection } from "@/components/settings/shortcuts-section"
import { KeybindingSettings } from "@/components/canvas/keybinding-settings"
import {
  getAppShortcutGroups,
  rebindAppShortcut,
  resetAppShortcut,
  type AppShortcutGroup,
} from "@/lib/shortcuts/unified"
import { getAppShortcutDescriptor } from "@/lib/shortcuts/app-catalog"
import { useAppKeybindingStore } from "@/stores/shortcuts/app-keybinding-store"
import { AppShortcutRecorderRow } from "./app-shortcut-recorder-row"

/**
 * The unified `Settings › Keyboard shortcuts` page. One home for all three
 * scopes: global system hotkeys (the existing ShortcutsSection), rebindable
 * in-app shortcuts (rendered inline from the app catalog), and the Canvas
 * editor keybindings (the existing KeybindingSettings editor). Each group reads
 * its own single-source store, so state stays consistent with every other
 * surface that shows the same shortcut.
 */
export function UnifiedShortcutsSection() {
  const t = useTranslations("settings.shortcuts")
  // Subscribe so the page re-renders when an app override changes.
  const overrides = useAppKeybindingStore((s) => s.overrides)
  const [query, setQuery] = useState("")

  const groups = useMemo<AppShortcutGroup[]>(
    () => getAppShortcutGroups(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute when overrides change
    [overrides]
  )

  const labelForId = (id: string): string => {
    const descriptor = getAppShortcutDescriptor(id)
    if (!descriptor) return id
    return t(`catalog.${descriptor.labelKey.split(".").pop()}`)
  }

  const q = query.trim().toLowerCase()
  const appGroups = q
    ? groups
        .map((group) => ({
          ...group,
          rows: group.rows.filter((row) => labelForId(row.descriptor.id).toLowerCase().includes(q)),
        }))
        .filter((group) => group.rows.length > 0)
    : groups

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <KeyboardIcon className="size-5" />
          <h2 className="text-lg font-semibold">{t("unified.title")}</h2>
        </div>
        <p className="text-sm text-muted-foreground">{t("unified.description")}</p>
      </div>

      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("unified.searchPlaceholder")}
        className="max-w-sm"
      />

      {/* Global system hotkeys — existing OS-level registrations. */}
      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-semibold">{t("unified.groupGlobal")}</h3>
          <p className="text-xs text-muted-foreground">{t("unified.groupGlobalHint")}</p>
        </div>
        <ShortcutsSection />
      </section>

      {/* In-app shortcuts — rebindable renderer-scope actions. */}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">{t("unified.groupApp")}</h3>
          <p className="text-xs text-muted-foreground">{t("unified.groupAppHint")}</p>
        </div>
        {appGroups.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("unified.noResults")}</p>
        ) : (
          appGroups.map((group) => (
            <div key={group.category} className="space-y-1">
              <h4 className="text-xs font-medium text-muted-foreground">
                {t(`categories.${group.category.replace(/^app\./, "")}`)}
              </h4>
              <ul className="divide-y rounded-md border bg-card">
                {group.rows.map((row) => (
                  <AppShortcutRecorderRow
                    key={row.descriptor.id}
                    row={row}
                    onRebind={rebindAppShortcut}
                    onReset={resetAppShortcut}
                    labelForId={labelForId}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      {/* Editor keybindings — the existing Canvas/Monaco editor. */}
      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-semibold">{t("unified.groupEditor")}</h3>
          <p className="text-xs text-muted-foreground">{t("unified.groupEditorHint")}</p>
        </div>
        <KeybindingSettings
          trigger={
            <Button variant="outline" size="sm" className="gap-2">
              <KeyboardIcon className="size-4" />
              {t("unified.openEditorKeybindings")}
            </Button>
          }
        />
      </section>
    </div>
  )
}

export default UnifiedShortcutsSection
