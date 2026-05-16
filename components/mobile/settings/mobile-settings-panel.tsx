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

import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import type { AppLanguage, AppTheme, BiometricGuardPolicy } from "@/lib/claude/types"
import { DEFAULT_BIOMETRIC_GUARD } from "@/lib/claude/types"
import { localeNames, locales } from "@/lib/i18n/config"
import { useSettingsStore } from "@/stores/settings"

export function MobileSettingsPanel() {
  const t = useTranslations("mobile.settingsPanel")
  const tSec = useTranslations("mobile.security")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const theme = (settings?.theme ?? "system") as AppTheme
  const language = (settings?.language ?? "en") as AppLanguage
  const fontScale = settings?.fontScale ?? "md"
  const defaultModel = settings?.defaultModel ?? ""
  const policy: BiometricGuardPolicy = settings?.biometricRequiredFor ?? DEFAULT_BIOMETRIC_GUARD

  const update = async (patch: Partial<NonNullable<typeof settings>>) => {
    await save(patch as never)
    const keys = Object.keys(patch ?? {}).join(", ")
    await enqueue({
      command: "app_settings_update",
      payload: { patch },
      label: t("queueLabel", { keys }),
    })
  }

  const updateBiometric = (patch: Partial<BiometricGuardPolicy>) =>
    update({ biometricRequiredFor: { ...policy, ...patch } })

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
            {locales.map((loc) => (
              <SelectItem key={loc} value={loc}>
                {localeNames[loc]}
              </SelectItem>
            ))}
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

      <section className="space-y-3 pt-2" data-testid="mobile-settings-biometric">
        <div className="space-y-0.5">
          <h3 className="text-xs font-semibold">{tSec("title")}</h3>
          <p className="text-[11px] text-muted-foreground">{tSec("description")}</p>
        </div>
        <BiometricRow
          label={tSec("deletePairing.label")}
          help={tSec("deletePairing.help")}
          checked={policy.deletePairing}
          onChange={(v) => void updateBiometric({ deletePairing: v })}
          testid="biometric-delete-pairing"
        />
        <BiometricRow
          label={tSec("exportBackup.label")}
          help={tSec("exportBackup.help")}
          checked={policy.exportBackup}
          onChange={(v) => void updateBiometric({ exportBackup: v })}
          testid="biometric-export-backup"
        />
        <BiometricRow
          label={tSec("revealSecrets.label")}
          help={tSec("revealSecrets.help")}
          checked={policy.revealSecrets}
          onChange={(v) => void updateBiometric({ revealSecrets: v })}
          testid="biometric-reveal-secrets"
        />
      </section>
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

function BiometricRow({
  label,
  help,
  checked,
  onChange,
  testid,
}: {
  label: string
  help: string
  checked: boolean
  onChange: (next: boolean) => void
  testid: string
}) {
  return (
    <Item size="sm" className="px-0">
      <ItemContent>
        <ItemTitle className="text-xs">{label}</ItemTitle>
        <ItemDescription className="text-[11px]">{help}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Switch
          checked={checked}
          onCheckedChange={onChange}
          data-testid={testid}
          aria-label={label}
        />
      </ItemActions>
    </Item>
  )
}
