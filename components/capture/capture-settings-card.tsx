"use client"

/**
 * Capture settings card — enable clipboard capture, pick the mode (confirm /
 * silent / manual), poll interval, confirm timeout, and privacy pause. Lives in
 * the pet-console "Insights" tab next to the radar (capture feeds the radar).
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { DEFAULT_CAPTURE_SETTINGS, type CaptureMode, type CaptureSettings } from "@/types/capture"

export function CaptureSettingsCard() {
  const t = useTranslations("capture.settings")
  const [settings, setSettings] = useState<CaptureSettings>(DEFAULT_CAPTURE_SETTINGS)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const row = await getSettings()
        if (!cancelled && row.capture) setSettings(row.capture)
      } catch {
        // Best-effort — keep defaults.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const onSave = useCallback(async () => {
    setSaving(true)
    try {
      await saveSettings({ capture: settings })
      toast.success(t("saved"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [settings, t])

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
        <CardDescription className="text-xs">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <div>
            <Label className="text-xs font-medium">{t("enabled")}</Label>
            <p className="text-[11px] text-muted-foreground">{t("enabledDesc")}</p>
          </div>
          <Switch
            checked={settings.enabled}
            onCheckedChange={(enabled) => setSettings({ ...settings, enabled })}
            aria-label={t("enabled")}
          />
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">{t("modeLabel")}</Label>
            <Select
              value={settings.mode}
              onValueChange={(v) => setSettings({ ...settings, mode: v as CaptureMode })}
            >
              <SelectTrigger className="h-8 text-xs" aria-label={t("modeLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="confirm">{t("mode.confirm")}</SelectItem>
                <SelectItem value="silent">{t("mode.silent")}</SelectItem>
                <SelectItem value="manual">{t("mode.manual")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">{t("pollInterval")}</Label>
            <Input
              type="number"
              min={0}
              step={500}
              value={settings.pollIntervalMs}
              onChange={(e) =>
                setSettings({ ...settings, pollIntervalMs: Number(e.target.value) || 0 })
              }
              className="h-8 text-xs"
              aria-label={t("pollInterval")}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[10px] text-muted-foreground">{t("confirmTimeout")}</Label>
            <Input
              type="number"
              min={1}
              value={settings.confirmTimeoutSec}
              onChange={(e) =>
                setSettings({ ...settings, confirmTimeoutSec: Number(e.target.value) || 1 })
              }
              className="h-8 text-xs"
              aria-label={t("confirmTimeout")}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-2">
          <div>
            <Label className="text-xs font-medium">{t("privacy")}</Label>
            <p className="text-[11px] text-muted-foreground">{t("privacyDesc")}</p>
          </div>
          <Switch
            checked={settings.privacyMode}
            onCheckedChange={(privacyMode) => setSettings({ ...settings, privacyMode })}
            aria-label={t("privacy")}
          />
        </div>

        <div className="flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void onSave()}
            disabled={saving}
            data-testid="capture-settings-save"
          >
            {saving ? <Loader2Icon className="h-3.5 w-3.5 animate-spin" /> : t("save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
