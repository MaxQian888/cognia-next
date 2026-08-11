"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2Icon } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { SettingsBlock } from "@/components/settings/common/settings-block"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { DEFAULT_CAPTURE_SETTINGS, type CaptureMode, type CaptureSettings } from "@/types/capture"

export function CaptureSettingsPanel() {
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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }, [settings, t])

  return (
    <SettingsBlock
      title={t("title")}
      description={t("description")}
      action={
        <Button
          size="sm"
          variant="outline"
          onClick={() => void onSave()}
          disabled={saving}
          data-testid="capture-settings-save"
        >
          {saving ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          {t("save")}
        </Button>
      }
    >
      <FieldGroup>
        <Field orientation="responsive">
          <FieldContent>
            <FieldLabel htmlFor="capture-enabled">{t("enabled")}</FieldLabel>
            <FieldDescription>{t("enabledDesc")}</FieldDescription>
          </FieldContent>
          <Switch
            id="capture-enabled"
            checked={settings.enabled}
            onCheckedChange={(enabled) => setSettings({ ...settings, enabled })}
          />
        </Field>

        <Field orientation="responsive">
          <FieldLabel htmlFor="capture-mode">{t("modeLabel")}</FieldLabel>
          <Select
            value={settings.mode}
            onValueChange={(mode) => setSettings({ ...settings, mode: mode as CaptureMode })}
          >
            <SelectTrigger id="capture-mode" className="w-full @md/field-group:w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="confirm">{t("mode.confirm")}</SelectItem>
                <SelectItem value="silent">{t("mode.silent")}</SelectItem>
                <SelectItem value="manual">{t("mode.manual")}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        <Field orientation="responsive">
          <FieldLabel htmlFor="capture-poll-interval">{t("pollInterval")}</FieldLabel>
          <Input
            id="capture-poll-interval"
            type="number"
            min={0}
            step={500}
            value={settings.pollIntervalMs}
            onChange={(event) =>
              setSettings({ ...settings, pollIntervalMs: Number(event.target.value) || 0 })
            }
            className="w-full @md/field-group:w-52"
          />
        </Field>

        <Field orientation="responsive">
          <FieldLabel htmlFor="capture-confirm-timeout">{t("confirmTimeout")}</FieldLabel>
          <Input
            id="capture-confirm-timeout"
            type="number"
            min={1}
            value={settings.confirmTimeoutSec}
            onChange={(event) =>
              setSettings({ ...settings, confirmTimeoutSec: Number(event.target.value) || 1 })
            }
            className="w-full @md/field-group:w-52"
          />
        </Field>

        <Field orientation="responsive">
          <FieldContent>
            <FieldLabel htmlFor="capture-privacy">{t("privacy")}</FieldLabel>
            <FieldDescription>{t("privacyDesc")}</FieldDescription>
          </FieldContent>
          <Switch
            id="capture-privacy"
            checked={settings.privacyMode}
            onCheckedChange={(privacyMode) => setSettings({ ...settings, privacyMode })}
          />
        </Field>
      </FieldGroup>
    </SettingsBlock>
  )
}
