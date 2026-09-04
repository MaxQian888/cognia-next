"use client"

/**
 * Settings → Automation → Whitelist tab.
 *
 * Two lists:
 *
 * - **Process names** — case-insensitive exact-match strings like
 *   `notepad.exe`. The Rust gate calls `Whitelist::matches` with the
 *   target's `process_name` and accepts the call when any entry matches.
 * - **Window title patterns** — tiny glob (`*` wildcard) strings like
 *   `*Excel*` or `Untitled - Notepad`. The Rust gate uses
 *   `glob_match(pattern, target.window_title)`.
 *
 * The global whitelist persists under `AutomationSettings.whitelist`
 * (top-level). The PerSurface whitelists in `permissionRs::SurfacePolicy`
 * are NOT edited from this tab — those are an advanced override that
 * defaults to `None` so the global list applies to every surface.
 *
 * "Add current focus window" calls `desktop.getFocus()` and prefills the
 * form with the focused window's process name and title. Useful when the
 * user wants to enable automation against a specific app without typing.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { CrosshairIcon, PlusIcon, TrashIcon } from "lucide-react"
import { toast } from "sonner"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { isTauri } from "@/lib/tauri"
import { AutomationUnavailableNotice } from "./automation-unavailable-notice"
import {
  desktop,
  defaultAutomationSettings,
  type AutomationSettings,
} from "@/lib/automation/client"

export function WhitelistTab() {
  const t = useTranslations("automation.whitelist")
  const [settings, setSettings] = useState<AutomationSettings | null>(() =>
    isTauri() ? null : defaultAutomationSettings()
  )
  const [loading, setLoading] = useState(() => isTauri())
  const [saving, setSaving] = useState(false)
  const [processInput, setProcessInput] = useState("")
  const [titleInput, setTitleInput] = useState("")
  const [currentFocus, setCurrentFocus] = useState<{
    processName: string | null
    windowTitle: string | null
  } | null>(null)

  useEffect(() => {
    if (!isTauri()) return
    desktop
      .settingsGet()
      .then(setSettings)
      .catch((err) => toast.error("Read failed", { description: String(err) }))
      .finally(() => setLoading(false))
  }, [])

  async function update(next: AutomationSettings) {
    setSaving(true)
    try {
      await desktop.settingsSet(next)
      setSettings(next)
    } catch (err) {
      toast.error(t("updateFailed"), { description: String(err) })
    } finally {
      setSaving(false)
    }
  }

  function addProcess(name: string) {
    if (!settings) return
    const trimmed = name.trim()
    if (!trimmed) return
    const existing = settings.whitelist.processNames
    if (existing.some((p) => p.toLowerCase() === trimmed.toLowerCase())) {
      toast.info("Already in the list")
      return
    }
    void update({
      ...settings,
      whitelist: {
        ...settings.whitelist,
        processNames: [...existing, trimmed],
      },
    })
    setProcessInput("")
  }

  function addPattern(pattern: string) {
    if (!settings) return
    const trimmed = pattern.trim()
    if (!trimmed) return
    const existing = settings.whitelist.windowTitlePatterns
    if (existing.includes(trimmed)) {
      toast.info("Already in the list")
      return
    }
    void update({
      ...settings,
      whitelist: {
        ...settings.whitelist,
        windowTitlePatterns: [...existing, trimmed],
      },
    })
    setTitleInput("")
  }

  function removeProcess(name: string) {
    if (!settings) return
    void update({
      ...settings,
      whitelist: {
        ...settings.whitelist,
        processNames: settings.whitelist.processNames.filter((p) => p !== name),
      },
    })
  }

  function removePattern(pattern: string) {
    if (!settings) return
    void update({
      ...settings,
      whitelist: {
        ...settings.whitelist,
        windowTitlePatterns: settings.whitelist.windowTitlePatterns.filter((p) => p !== pattern),
      },
    })
  }

  async function captureFocus() {
    try {
      const info = await desktop.getFocus()
      setCurrentFocus({
        processName: info.processName,
        windowTitle: info.windowTitle,
      })
      if (info.processName && !processInput) setProcessInput(info.processName)
      if (info.windowTitle && !titleInput) setTitleInput(info.windowTitle)
      toast.success(t("captureFocused"))
    } catch (err) {
      toast.error(t("captureFailed"), { description: String(err) })
    }
  }

  if (!isTauri()) return <AutomationUnavailableNotice />

  if (loading || !settings) {
    return <Skeleton className="h-72 w-full" />
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("quickCapture")}</CardTitle>
          <CardDescription>{t("quickCaptureHint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button onClick={captureFocus} disabled={saving} variant="secondary">
            <CrosshairIcon className="size-4 mr-2" />
            {t("captureFocused")}
          </Button>
          {currentFocus && (
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs font-mono">
              <div>
                <span className="text-muted-foreground">{t("processLabel")}</span>{" "}
                {currentFocus.processName ?? t("none")}
              </div>
              <div>
                <span className="text-muted-foreground">{t("titleLabel")}</span>{" "}
                {currentFocus.windowTitle ?? t("none")}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("processNames")}</CardTitle>
          <CardDescription>{t("processNamesHint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              addProcess(processInput)
            }}
          >
            <Input
              placeholder={t("processPlaceholder")}
              value={processInput}
              onChange={(e) => setProcessInput(e.target.value)}
              disabled={saving}
            />
            <Button type="submit" disabled={saving || !processInput.trim()}>
              <PlusIcon className="size-4 mr-1" />
              {t("add")}
            </Button>
          </form>
          {settings.whitelist.processNames.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("emptyProcess")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {settings.whitelist.processNames.map((p) => (
                <Badge key={p} variant="secondary" className="gap-1 pr-1">
                  <code className="font-mono">{p}</code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-5"
                    onClick={() => removeProcess(p)}
                    disabled={saving}
                    aria-label={t("removeEntryAria", { entry: p })}
                  >
                    <TrashIcon className="size-3" />
                  </Button>
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("windowTitles")}</CardTitle>
          <CardDescription>{t("windowTitlesHint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              addPattern(titleInput)
            }}
          >
            <Input
              placeholder={t("windowPlaceholder")}
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              disabled={saving}
            />
            <Button type="submit" disabled={saving || !titleInput.trim()}>
              <PlusIcon className="size-4 mr-1" />
              {t("add")}
            </Button>
          </form>
          {settings.whitelist.windowTitlePatterns.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("emptyWindow")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {settings.whitelist.windowTitlePatterns.map((p) => (
                <Badge key={p} variant="secondary" className="gap-1 pr-1">
                  <code className="font-mono">{p}</code>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-5"
                    onClick={() => removePattern(p)}
                    disabled={saving}
                    aria-label={t("removeEntryAria", { entry: p })}
                  >
                    <TrashIcon className="size-3" />
                  </Button>
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
