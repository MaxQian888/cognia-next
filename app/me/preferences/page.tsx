"use client"

/**
 * Mobile Preferences page — font scale, default model, and the
 * biometric-policy switches. Driven by `useSettingsStore` (same Dexie
 * row + `app_settings_update` RPC the rest of mobile uses).
 *
 * Chrome uses `MeSection` to match every other `/me/*` page (cf.
 * `/me`, `/me/help`, `/me/feedback`). The legacy bare-Card wrapper drifted
 * from the canonical mobile shell — wrapping in `MeSection` restores the
 * small-caps section header + `ItemGroup` border treatment the rest of
 * mobile uses. `BiometricRow` already renders via `Item` (same primitive
 * `MeRow` is built on), so it slots directly into `MeSection` children
 * without adapter shims.
 */

import { useTranslations } from "next-intl"

import { BiometricRow } from "@/components/mobile/me/biometric-row"
import { MeSection } from "@/components/mobile/me/me-section"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { Item, ItemContent, ItemTitle } from "@/components/ui/item"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import type { AppSettings, BiometricGuardPolicy } from "@/lib/claude/types"
import { DEFAULT_BIOMETRIC_GUARD } from "@/lib/claude/types"
import { useSettingsStore } from "@/stores/settings"

export default function MobilePreferencesPage() {
  const t = useTranslations("mobile.me")
  const tPanel = useTranslations("mobile.settingsPanel")
  const tSec = useTranslations("mobile.security")

  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const fontScale = settings?.fontScale ?? "md"
  const defaultModel = settings?.defaultModel ?? ""
  const policy: BiometricGuardPolicy = settings?.biometricRequiredFor ?? DEFAULT_BIOMETRIC_GUARD

  const update = async (patch: Partial<AppSettings>) => {
    await save(patch as never)
    const keys = Object.keys(patch ?? {}).join(", ")
    await enqueue({
      command: "app_settings_update",
      payload: { patch },
      label: tPanel("queueLabel", { keys }),
    })
  }

  const updateBiometric = (patch: Partial<BiometricGuardPolicy>) =>
    update({ biometricRequiredFor: { ...policy, ...patch } })

  return (
    <SubPageShell
      title={t("preferencesRow")}
      backAria={t("appearanceBackAria")}
      testid="mobile-preferences-page"
    >
      <div className="flex flex-col gap-4">
        <MeSection title={tPanel("fontScale")} testid="me-section-pref-display">
          <Item size="sm" className="px-0">
            <ItemContent>
              <ItemTitle className="text-xs">{tPanel("fontScale")}</ItemTitle>
              <Select
                value={fontScale}
                onValueChange={(v) => void update({ fontScale: v as never })}
              >
                <SelectTrigger data-testid="pref-font-scale" className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sm">{tPanel("fontScaleSm")}</SelectItem>
                  <SelectItem value="md">{tPanel("fontScaleMd")}</SelectItem>
                  <SelectItem value="lg">{tPanel("fontScaleLg")}</SelectItem>
                </SelectContent>
              </Select>
            </ItemContent>
          </Item>
          <Item size="sm" className="px-0">
            <ItemContent>
              <ItemTitle className="text-xs">{tPanel("defaultModel")}</ItemTitle>
              <Input
                value={defaultModel}
                onChange={(e) => void update({ defaultModel: e.target.value || undefined })}
                placeholder="claude-sonnet-4-6"
                data-testid="pref-default-model"
                className="mt-1"
              />
            </ItemContent>
          </Item>
        </MeSection>

        <MeSection
          title={tSec("title")}
          description={tSec("description")}
          testid="me-section-pref-security"
        >
          <BiometricRow
            label={tSec("deletePairing.label")}
            help={tSec("deletePairing.help")}
            checked={policy.deletePairing}
            onChange={(v) => void updateBiometric({ deletePairing: v })}
            testid="pref-biometric-delete-pairing"
          />
          <BiometricRow
            label={tSec("exportBackup.label")}
            help={tSec("exportBackup.help")}
            checked={policy.exportBackup}
            onChange={(v) => void updateBiometric({ exportBackup: v })}
            testid="pref-biometric-export-backup"
          />
          <BiometricRow
            label={tSec("revealSecrets.label")}
            help={tSec("revealSecrets.help")}
            checked={policy.revealSecrets}
            onChange={(v) => void updateBiometric({ revealSecrets: v })}
            testid="pref-biometric-reveal-secrets"
          />
          <BiometricRow
            label={t("signOut.biometricLabel")}
            help={t("signOut.biometricHelp")}
            checked={policy.signOut}
            onChange={(v) => void updateBiometric({ signOut: v })}
            testid="pref-biometric-sign-out"
          />
        </MeSection>
      </div>
    </SubPageShell>
  )
}
