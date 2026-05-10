"use client"

/**
 * Mobile Settings panel (Wave 2.7).
 *
 * Surfaces a small subset of `AppSettings` that's safe + useful from a
 * phone: theme, language, font scale, default model, biometric toggles.
 * Optimistic local Dexie write via the shared settings store, then
 * enqueues `app_settings_update` so the desktop reflects the same change
 * on next sync.
 *
 * The server-side allowlist (`APP_SETTINGS_MOBILE_ALLOWED_KEYS` in
 * `companion_api/rpc.rs`) rejects keys outside the safe list, so any
 * field added here that isn't in that allowlist will receive a 400.
 */

import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import type { AppLanguage, AppTheme } from "@/lib/claude/types"
import { useSettingsStore } from "@/stores/settings"

export function MobileSettingsPanel() {
  const t = useTranslations("mobile.settingsPanel")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const theme = (settings?.theme ?? "system") as AppTheme
  const language = (settings?.language ?? "en") as AppLanguage
  const fontScale = settings?.fontScale ?? "md"
  const defaultModel = settings?.defaultModel ?? ""

  const update = async (patch: Partial<NonNullable<typeof settings>>) => {
    await save(patch as never)
    const keys = Object.keys(patch ?? {}).join(", ")
    await enqueue({
      command: "app_settings_update",
      payload: { patch },
      label: t("queueLabel", { keys }),
    })
  }

  return (
    <div className="space-y-4" data-testid="mobile-settings-panel">
      <Row label={t("theme")}>
        <Select value={theme} onValueChange={(v) => void update({ theme: v as AppTheme })}>
          <SelectTrigger data-testid="settings-theme">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">{t("themeSystem")}</SelectItem>
            <SelectItem value="light">{t("themeLight")}</SelectItem>
            <SelectItem value="dark">{t("themeDark")}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label={t("language")}>
        <Select value={language} onValueChange={(v) => void update({ language: v as AppLanguage })}>
          <SelectTrigger data-testid="settings-language">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="en">English</SelectItem>
            <SelectItem value="zh-CN">中文</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label={t("fontScale")}>
        <Select value={fontScale} onValueChange={(v) => void update({ fontScale: v as never })}>
          <SelectTrigger data-testid="settings-font-scale">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sm">{t("fontScaleSm")}</SelectItem>
            <SelectItem value="md">{t("fontScaleMd")}</SelectItem>
            <SelectItem value="lg">{t("fontScaleLg")}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label={t("defaultModel")}>
        <Input
          value={defaultModel}
          onChange={(e) => void update({ defaultModel: e.target.value || undefined })}
          placeholder="claude-sonnet-4-6"
          data-testid="settings-default-model"
        />
      </Row>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Label className="flex flex-col gap-1 text-xs font-medium">
      <span>{label}</span>
      {children}
    </Label>
  )
}
