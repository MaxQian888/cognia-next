"use client"

/**
 * Mobile Speech & voice page — text-to-speech master toggle, provider, the
 * per-provider voice, the common rate/pitch/volume controls, auto-play, and
 * the speech-to-text language. Every field here is in the `app_settings_update`
 * allowlist (`APP_SETTINGS_MOBILE_ALLOWED_KEYS`, `companion_api/rpc.rs`), so
 * writes sync to the desktop the same way the rest of `/me/*` does.
 *
 * Same plumbing as `app/me/preferences/page.tsx`: optimistic `save()` into the
 * local Dexie settings row + an enqueued `app_settings_update` command so the
 * desktop reconciles on the next sync. Cloud-provider API keys are NOT writable
 * from mobile (not allowlisted) — they stay configured on desktop and the
 * provider + voice choice merely selects which configured voice to use.
 *
 * The per-provider voice id lives in a flat top-level AppSettings key per
 * provider (`openaiVoice`, `geminiVoice`, … / `systemVoice`), exactly as the
 * desktop `components/settings/speech/provider-config.tsx` writes them. These
 * voice keys are write-up only (NOT mirrored desktop→phone in
 * `CROSS_PLATFORM_SETTING_KEYS`), matching the Wave-2 `composerBehavior`
 * precedent — `systemVoice` in particular is device-specific.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { MeSection } from "@/components/mobile/me/me-section"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { useSettingsPatch } from "@/hooks/use-settings-patch"
import type { AppSettings } from "@cognia/agent-config-types"
import { useSettingsStore } from "@/stores/settings"
import {
  ORDERED_TTS_PROVIDERS,
  TTS_PROVIDER_SETTINGS,
  type SelectableTTSProvider,
} from "@cognia/tts/types"
import { SPEECH_LANGUAGES } from "@cognia/tts/speech"

/**
 * Voice picker. For cloud providers the catalogue is the static list shipped in
 * `types/media/tts`; for the system provider it reflects the device's installed
 * Web Speech voices (`"auto"` clears the override). `disabled` follows the TTS
 * master toggle.
 */
function VoiceSelect({
  provider,
  value,
  onChange,
  disabled,
  ariaLabel,
  autoLabel,
}: {
  provider: SelectableTTSProvider
  value: string
  onChange: (voice: string) => void
  disabled: boolean
  ariaLabel: string
  autoLabel: string
}) {
  const [systemVoices, setSystemVoices] = useState<{ id: string; name: string }[]>([])

  useEffect(() => {
    if (provider !== "system") return
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return
    const load = () =>
      setSystemVoices(
        window.speechSynthesis
          .getVoices()
          .map((v) => ({ id: v.voiceURI, name: `${v.name} (${v.lang})` }))
      )
    load()
    window.speechSynthesis.onvoiceschanged = load
    return () => {
      if ("speechSynthesis" in window) window.speechSynthesis.onvoiceschanged = null
    }
  }, [provider])

  const cfg = TTS_PROVIDER_SETTINGS[provider]
  const options =
    provider === "system"
      ? [{ id: "auto", name: autoLabel }, ...systemVoices]
      : (cfg.voices ?? []).map((v) => ({ id: v.id, name: v.name }))
  const selectValue = provider === "system" ? value || "auto" : value

  return (
    <Select
      value={selectValue}
      onValueChange={(v) => onChange(provider === "system" && v === "auto" ? "" : v)}
      disabled={disabled}
    >
      <SelectTrigger data-testid="speech-tts-voice" aria-label={ariaLabel} className="mt-1">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** STT language presets — `auto` clears the override (provider auto-detect).
 *  Codes come from the canonical `SPEECH_LANGUAGES` list (W18) so this can't
 *  drift from the rest of the subsystem. */
const STT_LANGUAGES = ["auto", ...SPEECH_LANGUAGES.map((l) => l.code)] as const

export default function MobileSpeechPage() {
  const t = useTranslations("mobile.speech")

  const settings = useSettingsStore((s) => s.settings)
  const saveLocalSettings = useSettingsStore((s) => s.save)
  const update = useSettingsPatch()

  const ttsEnabled = settings?.ttsEnabled ?? false
  const ttsProvider = (settings?.ttsProvider ?? "system") as SelectableTTSProvider
  const ttsRate = settings?.ttsRate ?? 1
  const ttsPitch = settings?.ttsPitch ?? 1
  const ttsVolume = settings?.ttsVolume ?? 1
  const ttsAutoPlay = settings?.ttsAutoPlay ?? false
  const sttLanguage = settings?.sttLanguage ?? "auto"

  const voiceCfg = TTS_PROVIDER_SETTINGS[ttsProvider]
  const currentVoice =
    (settings?.[voiceCfg.voiceSettingKey as keyof AppSettings] as string | undefined) ??
    voiceCfg.fallbackVoice

  return (
    <SubPageShell title={t("title")} backAria={t("backAria")} testid="mobile-speech-page">
      <div className="flex flex-col gap-4">
        <MeSection
          title={t("ttsTitle")}
          description={t("ttsDescription")}
          testid="me-section-speech-tts"
        >
          <Item size="sm" className="px-0">
            <ItemContent>
              <ItemTitle className="text-xs">{t("ttsEnabled")}</ItemTitle>
              <ItemDescription className="text-[11px]">{t("ttsEnabledHelp")}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                checked={ttsEnabled}
                onCheckedChange={(v) => void update({ ttsEnabled: v })}
                data-testid="speech-tts-enabled"
                aria-label={t("ttsEnabled")}
              />
            </ItemActions>
          </Item>

          <Item size="sm" className="px-0">
            <ItemContent>
              <ItemTitle className="text-xs">{t("provider")}</ItemTitle>
              <ItemDescription className="text-[11px]">{t("providerHelp")}</ItemDescription>
              <Select
                value={ttsProvider}
                onValueChange={(v) => void update({ ttsProvider: v as never })}
                disabled={!ttsEnabled}
              >
                <SelectTrigger
                  data-testid="speech-tts-provider"
                  aria-label={t("provider")}
                  className="mt-1"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ORDERED_TTS_PROVIDERS.map((id) => (
                    <SelectItem key={id} value={id}>
                      {t(`providers.${id}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ItemContent>
          </Item>

          {voiceCfg.voices !== null || ttsProvider === "system" ? (
            <Item size="sm" className="px-0">
              <ItemContent>
                <ItemTitle className="text-xs">{t("voice")}</ItemTitle>
                <ItemDescription className="text-[11px]">{t("voiceHelp")}</ItemDescription>
                <VoiceSelect
                  provider={ttsProvider}
                  value={currentVoice}
                  onChange={(v) =>
                    void update({
                      [voiceCfg.voiceSettingKey]: v,
                    } as Partial<AppSettings>)
                  }
                  disabled={!ttsEnabled}
                  ariaLabel={t("voice")}
                  autoLabel={t("voiceAuto")}
                />
              </ItemContent>
            </Item>
          ) : (
            <Item size="sm" className="px-0">
              <ItemContent>
                <ItemTitle className="text-xs">{t("voice")}</ItemTitle>
                <ItemDescription className="text-[11px]">{t("voiceHelp")}</ItemDescription>
                <Input
                  aria-label={t("voice")}
                  disabled={!ttsEnabled}
                  onChange={(event) =>
                    void update({
                      [voiceCfg.voiceSettingKey]: event.target.value,
                    } as Partial<AppSettings>)
                  }
                  value={currentVoice}
                />
              </ItemContent>
            </Item>
          )}

          {ttsProvider === "local-openai-compatible" && (
            <Item size="sm" className="px-0">
              <ItemContent>
                <ItemTitle className="text-xs">{t("localEndpoint")}</ItemTitle>
                <ItemDescription className="text-[11px]">
                  {t("localEndpointHelp")}
                </ItemDescription>
                <Input
                  aria-label={t("localEndpoint")}
                  disabled={!ttsEnabled}
                  onChange={(event) =>
                    void saveLocalSettings({ localOpenaiBaseUrl: event.target.value })
                  }
                  value={settings?.localOpenaiBaseUrl ?? ""}
                />
                <Input
                  aria-label={t("model")}
                  className="mt-2"
                  disabled={!ttsEnabled}
                  onChange={(event) =>
                    void saveLocalSettings({ localOpenaiModel: event.target.value })
                  }
                  value={settings?.localOpenaiModel ?? ""}
                />
              </ItemContent>
            </Item>
          )}

          {/* Rate + pitch only affect the system voice; cloud providers use
              their own speed field, so these were dead controls for them (W13). */}
          {ttsProvider === "system" && (
            <>
              <Item size="sm" className="px-0">
                <ItemContent>
                  <ItemTitle className="text-xs">
                    {t("rate")} · {ttsRate.toFixed(1)}×
                  </ItemTitle>
                  <Slider
                    value={[ttsRate]}
                    min={0.5}
                    max={2}
                    step={0.1}
                    disabled={!ttsEnabled}
                    onValueChange={([v]) => void update({ ttsRate: v })}
                    data-testid="speech-tts-rate"
                    aria-label={t("rate")}
                    className="mt-2"
                  />
                </ItemContent>
              </Item>

              <Item size="sm" className="px-0">
                <ItemContent>
                  <ItemTitle className="text-xs">
                    {t("pitch")} · {ttsPitch.toFixed(1)}
                  </ItemTitle>
                  <Slider
                    value={[ttsPitch]}
                    min={0}
                    max={2}
                    step={0.1}
                    disabled={!ttsEnabled}
                    onValueChange={([v]) => void update({ ttsPitch: v })}
                    data-testid="speech-tts-pitch"
                    aria-label={t("pitch")}
                    className="mt-2"
                  />
                </ItemContent>
              </Item>
            </>
          )}

          <Item size="sm" className="px-0">
            <ItemContent>
              <ItemTitle className="text-xs">
                {t("volume")} · {Math.round(ttsVolume * 100)}%
              </ItemTitle>
              <Slider
                value={[ttsVolume]}
                min={0}
                max={1}
                step={0.05}
                disabled={!ttsEnabled}
                onValueChange={([v]) => void update({ ttsVolume: v })}
                data-testid="speech-tts-volume"
                aria-label={t("volume")}
                className="mt-2"
              />
            </ItemContent>
          </Item>

          <Item size="sm" className="px-0">
            <ItemContent>
              <ItemTitle className="text-xs">{t("autoPlay")}</ItemTitle>
              <ItemDescription className="text-[11px]">{t("autoPlayHelp")}</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Switch
                checked={ttsAutoPlay}
                onCheckedChange={(v) => void update({ ttsAutoPlay: v })}
                disabled={!ttsEnabled}
                data-testid="speech-tts-autoplay"
                aria-label={t("autoPlay")}
              />
            </ItemActions>
          </Item>
        </MeSection>

        <MeSection title={t("sttTitle")} testid="me-section-speech-stt">
          <Item size="sm" className="px-0">
            <ItemContent>
              <ItemTitle className="text-xs">{t("sttLanguage")}</ItemTitle>
              <ItemDescription className="text-[11px]">{t("sttLanguageHelp")}</ItemDescription>
              <Select
                value={sttLanguage}
                onValueChange={(v) => void update({ sttLanguage: v === "auto" ? undefined : v })}
              >
                <SelectTrigger
                  data-testid="speech-stt-language"
                  aria-label={t("sttLanguage")}
                  className="mt-1"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STT_LANGUAGES.map((code) => (
                    <SelectItem key={code} value={code}>
                      {code === "auto" ? t("sttAuto") : code}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ItemContent>
          </Item>
        </MeSection>
      </div>
    </SubPageShell>
  )
}
