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
  SELECTION_TOOLBAR_DISABLED_SITES_PREF,
  SELECTION_TOOLBAR_ENABLED_PREF,
  SELECTION_TOOLBAR_MODE_PREF,
  getSelectionToolbarStatus,
  repairSelectionToolbarPermission,
  startSelectionToolbar,
  stopSelectionToolbar,
  type SelectionPermissionProbeState,
  type SelectionToolbarStatus,
} from "@/lib/tauri/selection-toolbar"
import {
  SELECTION_CONTEXTUAL_ACTIONS_PREF,
  SELECTION_TRANSLATE_LOCALE_PREF,
  TARGET_LOCALES,
  initialTargetLocale,
  type TargetLocale,
} from "@/components/selection-toolbar/selection-toolbar-actions"
import {
  defaultSearchEngine,
  isSearchEngineId,
  SEARCH_ENGINES,
  SELECTION_SEARCH_ENGINE_PREF,
  type SearchEngineId,
} from "@/lib/selection/search-engines"
import {
  migrateSelectionToolbarMode,
  normalizeHostnameRules,
  type SelectionToolbarMode,
} from "@/lib/selection/preferences"
import { getPref, setPref } from "@/lib/tauri/store"
import { SelectionActionManager } from "./selection-action-manager"

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
  const [mode, setMode] = useState<SelectionToolbarMode>("off")
  const [disabledAppsText, setDisabledAppsText] = useState("")
  const [disabledSitesText, setDisabledSitesText] = useState("")
  const [translateLocale, setTranslateLocale] = useState<TargetLocale>(() =>
    initialTargetLocale(locale)
  )
  const [loaded, setLoaded] = useState(false)
  const [contextualEnabled, setContextualEnabled] = useState(true)
  const [searchEngine, setSearchEngine] = useState<SearchEngineId>(() =>
    defaultSearchEngine(locale)
  )
  const [status, setStatus] = useState<SelectionToolbarStatus | null>(null)

  useEffect(() => {
    let alive = true
    void Promise.all([
      getPref<boolean>(SELECTION_TOOLBAR_ENABLED_PREF),
      getPref<SelectionToolbarMode>(SELECTION_TOOLBAR_MODE_PREF),
      getPref<string[]>(SELECTION_TOOLBAR_DISABLED_APPS_PREF),
      getPref<string[]>(SELECTION_TOOLBAR_DISABLED_SITES_PREF),
      getPref<string>(SELECTION_TRANSLATE_LOCALE_PREF),
      getPref<boolean>(SELECTION_CONTEXTUAL_ACTIONS_PREF),
      getPref<string>(SELECTION_SEARCH_ENGINE_PREF),
      getSelectionToolbarStatus(),
    ]).then(
      ([
        savedEnabled,
        savedMode,
        disabledApps,
        disabledSites,
        savedTranslateLocale,
        savedContextual,
        savedSearchEngine,
        liveStatus,
      ]) => {
        if (!alive) return
        const nextMode = migrateSelectionToolbarMode(
          savedMode ?? undefined,
          savedEnabled ?? undefined
        )
        setMode(nextMode)
        setEnabled(nextMode !== "off")
        setDisabledAppsText(Array.isArray(disabledApps) ? disabledApps.join("\n") : "")
        setDisabledSitesText(Array.isArray(disabledSites) ? disabledSites.join("\n") : "")
        if (TARGET_LOCALES.includes(savedTranslateLocale as TargetLocale)) {
          setTranslateLocale(savedTranslateLocale as TargetLocale)
        }
        setContextualEnabled(savedContextual !== false)
        if (isSearchEngineId(savedSearchEngine)) setSearchEngine(savedSearchEngine)
        setStatus(liveStatus)
        setLoaded(true)
      }
    )
    return () => {
      alive = false
    }
  }, [])

  const chooseTranslateLocale = async (next: TargetLocale) => {
    setTranslateLocale(next)
    await setPref(SELECTION_TRANSLATE_LOCALE_PREF, next)
  }

  const applyMode = async (nextMode: SelectionToolbarMode) => {
    const disabledApps = normalizeDisabledApps(disabledAppsText)
    const disabledSites = normalizeHostnameRules(disabledSitesText.split("\n"))
    try {
      if (nextMode !== "off") {
        setStatus(await startSelectionToolbar({ mode: nextMode, disabledApps, disabledSites }))
      } else {
        setStatus(await stopSelectionToolbar())
      }
      setMode(nextMode)
      setEnabled(nextMode !== "off")
      await Promise.all([
        setPref(SELECTION_TOOLBAR_MODE_PREF, nextMode),
        setPref(SELECTION_TOOLBAR_ENABLED_PREF, nextMode !== "off"),
      ])
    } catch (error) {
      // Which way to fail depends on which call failed.
      //
      // A failed START never began capturing, so "off" is the truth and
      // persisting it is right. A failed STOP is the opposite: the native
      // monitor and the global chords are still live. Recording "off" there
      // would tell the user that system-wide text capture is disabled while it
      // keeps running, and the next launch would not even try to stop it. So
      // the control stays on, and the user is told the stop did not take.
      const stopFailed = nextMode === "off"
      const persistedMode = stopFailed ? mode : "off"
      setMode(persistedMode)
      setEnabled(persistedMode !== "off")
      await Promise.all([
        setPref(SELECTION_TOOLBAR_MODE_PREF, persistedMode),
        setPref(SELECTION_TOOLBAR_ENABLED_PREF, persistedMode !== "off"),
      ])
      toast.error(t(stopFailed ? "disableFailed" : "enableFailed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const handleToggle = (next: boolean) => applyMode(next ? "automatic" : "off")

  const saveExclusions = async () => {
    const disabledApps = normalizeDisabledApps(disabledAppsText)
    const disabledSites = normalizeHostnameRules(disabledSitesText.split("\n"))
    setDisabledAppsText(disabledApps.join("\n"))
    setDisabledSitesText(disabledSites.join("\n"))
    await Promise.all([
      setPref(SELECTION_TOOLBAR_DISABLED_APPS_PREF, disabledApps),
      setPref(SELECTION_TOOLBAR_DISABLED_SITES_PREF, disabledSites),
    ])
    if (!enabled) return
    try {
      setStatus(
        await startSelectionToolbar({
          mode: mode === "off" ? "automatic" : mode,
          disabledApps,
          disabledSites,
        })
      )
    } catch (error) {
      toast.error(t("enableFailed"), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const refreshStatus = async () => setStatus(await getSelectionToolbarStatus())

  const chooseContextual = async (next: boolean) => {
    setContextualEnabled(next)
    await setPref(SELECTION_CONTEXTUAL_ACTIONS_PREF, next)
  }

  const chooseSearchEngine = async (next: SearchEngineId) => {
    setSearchEngine(next)
    await setPref(SELECTION_SEARCH_ENGINE_PREF, next)
  }

  const probeLabel = (value: SelectionPermissionProbeState) => t(`probes.${value}` as never)

  return (
    <section className="space-y-3 rounded-md border p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label className="flex items-center gap-2 text-sm">
            <ScanTextIcon className="size-3.5" />
            {t("title")}
          </Label>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Switch
          checked={enabled}
          disabled={!loaded}
          onCheckedChange={(next) => void handleToggle(next)}
          aria-label={t("toggle")}
        />
      </div>
      <div className="space-y-2 border-t pt-3">
        <Label htmlFor="selection-toolbar-mode" className="text-xs">
          {t("mode")}
        </Label>
        <Select
          value={mode}
          disabled={!loaded}
          onValueChange={(next) => void applyMode(next as SelectionToolbarMode)}
        >
          <SelectTrigger
            id="selection-toolbar-mode"
            aria-label={t("mode")}
            size="sm"
            className="w-56"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">{t("modes.off")}</SelectItem>
            <SelectItem value="automatic">{t("modes.automatic")}</SelectItem>
            <SelectItem value="manual">{t("modes.manual")}</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t("modeHint")}</p>
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
          <SelectTrigger
            aria-label={t("translateLanguage")}
            id="selection-toolbar-translate-locale"
            size="sm"
            className="w-56"
          >
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
      <div className="space-y-3 border-t pt-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label className="text-xs">{t("contextualActions")}</Label>
            <p className="text-xs text-muted-foreground">{t("contextualActionsHint")}</p>
          </div>
          <Switch
            checked={contextualEnabled}
            disabled={!loaded}
            onCheckedChange={(next) => void chooseContextual(next)}
            aria-label={t("contextualActions")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="selection-toolbar-search-engine" className="text-xs">
            {t("searchEngine")}
          </Label>
          <Select
            value={searchEngine}
            disabled={!loaded}
            onValueChange={(next) => void chooseSearchEngine(next as SearchEngineId)}
          >
            <SelectTrigger
              aria-label={t("searchEngine")}
              id="selection-toolbar-search-engine"
              size="sm"
              className="w-56"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEARCH_ENGINES.map((engine) => (
                <SelectItem key={engine} value={engine}>
                  {t(`searchEngines.${engine}` as never)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
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
          <Button type="button" size="sm" variant="outline" onClick={() => void saveExclusions()}>
            {t("saveDisabledApps")}
          </Button>
        </div>
      </div>
      <div className="space-y-2 border-t pt-3">
        <Label htmlFor="selection-toolbar-disabled-sites" className="text-xs">
          {t("disabledSites")}
        </Label>
        <Textarea
          id="selection-toolbar-disabled-sites"
          value={disabledSitesText}
          onChange={(event) => setDisabledSitesText(event.target.value)}
          placeholder={t("disabledSitesPlaceholder")}
          className="min-h-20 text-xs"
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">{t("disabledSitesHint")}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void saveExclusions()}>
            {t("saveDisabledSites")}
          </Button>
        </div>
      </div>
      {status ? (
        <div className="space-y-2 border-t pt-3">
          <div className="flex items-center justify-between gap-3">
            <Label className="text-xs">{t("health")}</Label>
            <Button type="button" size="sm" variant="ghost" onClick={() => void refreshStatus()}>
              {t("refreshStatus")}
            </Button>
          </div>
          {(["accessibility", "inputMonitoring", "screenRecording", "uia"] as const).map(
            (permission) => (
              <div key={permission} className="flex items-center justify-between gap-3 text-xs">
                <span>{t(`permissions.${permission}` as never)}</span>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">{probeLabel(status[permission])}</span>
                  {status[permission] === "missing" && permission !== "uia" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void repairSelectionToolbarPermission(permission)}
                    >
                      {t("openSettings")}
                    </Button>
                  ) : null}
                </div>
              </div>
            )
          )}
          <p className="text-xs text-muted-foreground">
            {status.ocrAvailable ? t("ocrAvailable") : t("ocrUnavailable")}
          </p>
          <div className="flex items-center justify-between gap-3 text-xs">
            <span>{t("shortcutScope")}</span>
            <span className="text-muted-foreground">
              {status.shortcutActivationActive ? t("shortcutActive") : t("shortcutInactive")}
            </span>
          </div>
        </div>
      ) : null}
      <SelectionActionManager replaceAvailable={status?.replaceAvailable ?? false} />
    </section>
  )
}

export default SelectionToolbarSettings
