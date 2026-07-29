"use client"

import { useEffect, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import { ScanTextIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  SELECTION_TOOLBAR_DISABLED_APPS_PREF,
  SELECTION_TOOLBAR_ENABLED_PREF,
  startSelectionToolbar,
  stopSelectionToolbar,
} from "@/lib/tauri/selection-toolbar"
import {
  SELECTION_TRANSLATE_LOCALE_PREF,
  TARGET_LOCALES,
  initialTargetLocale,
  type TargetLocale,
} from "@/components/selection-toolbar/selection-toolbar-actions"
import { getPref, setPref } from "@/lib/tauri/store"

function normalizeDisabledApps(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split("\n")
        .map((app) => app.trim())
        .filter(Boolean)
    )
  )
}

export function SelectionToolbarSettings() {
  const t = useTranslations("settings.desktop.selectionToolbar")
  const tToolbar = useTranslations("selectionToolbar")
  const locale = useLocale()
  const [enabled, setEnabled] = useState(false)
  const [disabledAppsText, setDisabledAppsText] = useState("")
  const [translateLocale, setTranslateLocale] = useState<TargetLocale>(() =>
    initialTargetLocale(locale)
  )
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    void Promise.all([
      getPref<boolean>(SELECTION_TOOLBAR_ENABLED_PREF),
      getPref<string[]>(SELECTION_TOOLBAR_DISABLED_APPS_PREF),
      getPref<string>(SELECTION_TRANSLATE_LOCALE_PREF),
    ]).then(([savedEnabled, disabledApps, savedTranslateLocale]) => {
      if (!alive) return
      setEnabled(savedEnabled === true)
      setDisabledAppsText((disabledApps ?? []).join("\n"))
      if (TARGET_LOCALES.includes(savedTranslateLocale as TargetLocale)) {
        setTranslateLocale(savedTranslateLocale as TargetLocale)
      }
      setLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [])

  const chooseTranslateLocale = async (next: TargetLocale) => {
    setTranslateLocale(next)
    await setPref(SELECTION_TRANSLATE_LOCALE_PREF, next)
  }

  const handleToggle = async (next: boolean) => {
    const disabledApps = normalizeDisabledApps(disabledAppsText)
    try {
      if (next) await startSelectionToolbar(disabledApps)
      else await stopSelectionToolbar()
      setEnabled(next)
      await setPref(SELECTION_TOOLBAR_ENABLED_PREF, next)
    } catch (error) {
      setEnabled(false)
      await setPref(SELECTION_TOOLBAR_ENABLED_PREF, false)
      toast.error(t("enableFailed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const saveDisabledApps = async () => {
    const disabledApps = normalizeDisabledApps(disabledAppsText)
    setDisabledAppsText(disabledApps.join("\n"))
    await setPref(SELECTION_TOOLBAR_DISABLED_APPS_PREF, disabledApps)
    if (!enabled) return
    try {
      await startSelectionToolbar(disabledApps)
    } catch (error) {
      toast.error(t("enableFailed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <section className="space-y-3 rounded-md border p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label className="flex items-center gap-2 text-sm">
            <ScanTextIcon className="size-3.5" />
            {t("title")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
          <p className="text-xs text-muted-foreground">{t("permissionHint")}</p>
        </div>
        <Switch
          checked={enabled}
          disabled={!loaded}
          onCheckedChange={(next) => void handleToggle(next)}
          aria-label={t("toggle")}
        />
      </div>
      {/*
        The toolbar itself persists this pref, but until now the only way to
        change it was the floating capsule — which disappears after ten seconds.
      */}
      <div className="space-y-2 border-t pt-3">
        <Label htmlFor="selection-toolbar-translate-locale" className="text-xs">
          {t("translateLanguage")}
        </Label>
        <Select
          value={translateLocale}
          disabled={!loaded}
          onValueChange={(next) => void chooseTranslateLocale(next as TargetLocale)}
        >
          <SelectTrigger id="selection-toolbar-translate-locale" size="sm" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TARGET_LOCALES.map((target) => (
              <SelectItem key={target} value={target}>
                {tToolbar(`languages.${target}` as never)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t("translateLanguageHint")}</p>
      </div>
      <div className="space-y-2 border-t pt-3">
        <Label htmlFor="selection-toolbar-disabled-apps" className="text-xs">
          {t("disabledApps")}
        </Label>
        <Textarea
          id="selection-toolbar-disabled-apps"
          value={disabledAppsText}
          onChange={(event) => setDisabledAppsText(event.target.value)}
          placeholder={t("disabledAppsPlaceholder")}
          className="min-h-20 text-xs"
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">{t("disabledAppsHint")}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void saveDisabledApps()}>
            {t("saveDisabledApps")}
          </Button>
        </div>
      </div>
    </section>
  )
}

export default SelectionToolbarSettings
