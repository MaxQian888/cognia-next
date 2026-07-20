// Model-behavior settings (Settings → Automation → Overview card).
//
// Surfaces the three "model view" knobs the Rust side honors:
//   - screenshot down-scaling (off by default; 1280×800 WXGA when enabled)
//   - screenshot dedup ("screen unchanged" text instead of duplicate frames)
//   - clipboard-paste threshold for long `type` actions (0 disables)
//
// Reads/writes the full `AutomationSettings` blob via the existing
// `desktop.settingsGet` / `settingsSet` commands — same persistence pattern
// as the Permissions tab. Mirrors `ScreenOffCard`'s inline-error style.

"use client"

import { useEffect, useState } from "react"

import { Images, MonitorPlay, Sparkles } from "lucide-react"
import { useTranslations } from "next-intl"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { desktop, type AutomationSettings } from "@/lib/automation/client"
import { setComputerUsePipAlwaysHidden } from "@/lib/automation/computer-use-pip"

export function BehaviorCard() {
  const t = useTranslations("automation.behavior")
  const [settings, setSettings] = useState<AutomationSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    desktop
      .settingsGet()
      .then((s) => {
        if (!cancelled) {
          setSettings(s)
          setComputerUsePipAlwaysHidden(s.alwaysHidePictureInPicture)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function save(next: AutomationSettings) {
    setSettings(next)
    setComputerUsePipAlwaysHidden(next.alwaysHidePictureInPicture)
    setError(null)
    try {
      await desktop.settingsSet(next)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (!settings) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4" aria-hidden="true" />
            <span>{t("title")}</span>
          </CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        {error && (
          <CardContent>
            <p className="font-mono text-xs text-rose-500">{error}</p>
          </CardContent>
        )}
      </Card>
    )
  }

  const scaling = settings.screenshotScaling

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4" aria-hidden="true" />
          <span>{t("title")}</span>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="behavior-hide-pip" className="flex items-center gap-2">
              <MonitorPlay className="size-4" aria-hidden="true" />
              {t("pictureInPicture.label")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("pictureInPicture.help")}</p>
          </div>
          <Switch
            id="behavior-hide-pip"
            checked={settings.alwaysHidePictureInPicture}
            onCheckedChange={(v) =>
              void save({ ...settings, alwaysHidePictureInPicture: Boolean(v) })
            }
          />
        </div>

        {/* Screenshot down-scaling */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="behavior-scaling" className="flex items-center gap-2">
              <Images className="size-4" aria-hidden="true" />
              {t("scaling.label")}
            </Label>
            <p className="text-xs text-muted-foreground">{t("scaling.help")}</p>
          </div>
          <Switch
            id="behavior-scaling"
            checked={scaling.enabled}
            onCheckedChange={(v) =>
              void save({ ...settings, screenshotScaling: { ...scaling, enabled: Boolean(v) } })
            }
          />
        </div>
        {scaling.enabled && (
          <div className="grid grid-cols-2 gap-2 sm:max-w-xs">
            <div className="space-y-1">
              <Label htmlFor="behavior-scaling-w" className="text-xs">
                {t("scaling.maxWidth")}
              </Label>
              <Input
                id="behavior-scaling-w"
                type="number"
                min={320}
                max={3840}
                value={scaling.maxWidth}
                onChange={(e) =>
                  void save({
                    ...settings,
                    screenshotScaling: {
                      ...scaling,
                      maxWidth: Math.min(3840, Math.max(320, Number(e.target.value) || 1280)),
                    },
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="behavior-scaling-h" className="text-xs">
                {t("scaling.maxHeight")}
              </Label>
              <Input
                id="behavior-scaling-h"
                type="number"
                min={240}
                max={2400}
                value={scaling.maxHeight}
                onChange={(e) =>
                  void save({
                    ...settings,
                    screenshotScaling: {
                      ...scaling,
                      maxHeight: Math.min(2400, Math.max(240, Number(e.target.value) || 800)),
                    },
                  })
                }
              />
            </div>
          </div>
        )}

        {/* Screenshot dedup */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="behavior-dedup">{t("dedup.label")}</Label>
            <p className="text-xs text-muted-foreground">{t("dedup.help")}</p>
          </div>
          <Switch
            id="behavior-dedup"
            checked={settings.screenshotDedup}
            onCheckedChange={(v) => void save({ ...settings, screenshotDedup: Boolean(v) })}
          />
        </div>

        {/* Paste threshold */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="behavior-paste-threshold">{t("pasteThreshold.label")}</Label>
            <p className="text-xs text-muted-foreground">{t("pasteThreshold.help")}</p>
          </div>
          <Input
            id="behavior-paste-threshold"
            type="number"
            min={0}
            max={100000}
            className="sm:w-28"
            value={settings.pasteThresholdChars}
            onChange={(e) =>
              void save({
                ...settings,
                pasteThresholdChars: Math.max(0, Number(e.target.value) || 0),
              })
            }
          />
        </div>

        {error && <p className="font-mono text-xs text-rose-500">{error}</p>}
      </CardContent>
    </Card>
  )
}
