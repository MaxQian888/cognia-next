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
import { useEffect, useState } from "react"
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
import type { BiometricGuardPolicy } from "@cognia/agent-config-types"
import { DEFAULT_BIOMETRIC_GUARD } from "@cognia/agent-config-types"
import { useSettingsPatch } from "@/hooks/use-settings-patch"
import { isImeComposing } from "@/lib/ui/ime"
import {
  getBehaviorTelemetrySettings,
  setBehaviorTelemetryEnabled,
} from "@/lib/telemetry/events/settings"
import { trackEvent } from "@/lib/telemetry/events/track-event"
import { useSettingsStore } from "@/stores/settings"

export default function MobilePreferencesPage() {
  const t = useTranslations("mobile.me")
  const tPanel = useTranslations("mobile.settingsPanel")
  const tSec = useTranslations("mobile.security")

  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsPatch()

  const fontScale = settings?.fontScale ?? "md"
  const defaultModel = settings?.defaultModel ?? ""
  const policy: BiometricGuardPolicy = settings?.biometricRequiredFor ?? DEFAULT_BIOMETRIC_GUARD
  const reduceMotion = settings?.reduceMotion ?? false
  const telemetryEnabled =
    settings?.behaviorTelemetry?.enabled ??
    settings?.telemetryEnabled ??
    getBehaviorTelemetrySettings().enabled

  useEffect(() => {
    if (!settings?.behaviorTelemetry && settings?.telemetryEnabled) {
      setBehaviorTelemetryEnabled(true)
    }
  }, [settings?.behaviorTelemetry, settings?.telemetryEnabled])

  // The model id is typed, so it is committed on blur or Enter, not per
  // keystroke. Each save mirrors to a paired desktop as its own queued
  // `app_settings_update`: typing "claude-opus" queued eleven jobs and set the
  // desktop's default model to "c", "cl", "cla", … on the way. The draft is
  // released once the write lands, unless typing has moved on since.
  const [modelDraft, setModelDraft] = useState<string | null>(null)
  const commitDefaultModel = () => {
    if (modelDraft === null) return
    const draft = modelDraft
    const next = draft.trim()
    if (next === defaultModel) {
      setModelDraft(null)
      return
    }
    void Promise.resolve(update({ defaultModel: next || undefined })).finally(() =>
      setModelDraft((current) => (current === draft ? null : current))
    )
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
        {/* Titled for both rows: "Font scale" headed a section whose second
            row is the default model. */}
        <MeSection title={tPanel("displayAndModelTitle")} testid="me-section-pref-display">
          <Item size="sm" className="px-0">
            <ItemContent>
              <ItemTitle className="text-xs">{tPanel("fontScale")}</ItemTitle>
              <Select
                value={fontScale}
                onValueChange={(v) => void update({ fontScale: v as never })}
              >
                <SelectTrigger
                  data-testid="pref-font-scale"
                  className="mt-1"
                  aria-label={tPanel("fontScale")}
                >
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
                value={modelDraft ?? defaultModel}
                onChange={(e) => setModelDraft(e.target.value)}
                onBlur={commitDefaultModel}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || isImeComposing(e)) return
                  e.preventDefault()
                  commitDefaultModel()
                }}
                placeholder="claude-sonnet-4-6"
                aria-label={tPanel("defaultModel")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
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

        <MeSection title={tPanel("privacyTitle")} testid="me-section-pref-privacy">
          <BiometricRow
            label={tPanel("reduceMotion")}
            help={tPanel("reduceMotionHelp")}
            checked={reduceMotion}
            onChange={(v) => void update({ reduceMotion: v })}
            testid="pref-reduce-motion"
          />
          <BiometricRow
            label={tPanel("telemetry")}
            help={tPanel("telemetryHelp")}
            checked={telemetryEnabled}
            onChange={(v) => {
              if (!v) void trackEvent("telemetry.preference.changed", { enabled: false })
              const behaviorTelemetry = setBehaviorTelemetryEnabled(v)
              if (v) void trackEvent("telemetry.preference.changed", { enabled: true })
              void update({ telemetryEnabled: v, behaviorTelemetry })
            }}
            testid="pref-telemetry"
          />
        </MeSection>
      </div>
    </SubPageShell>
  )
}
