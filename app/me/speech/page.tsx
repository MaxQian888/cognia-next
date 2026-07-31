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
import { useSettingsPatch } from "@/hooks/use-settings-patch"
import type { AppSettings } from "@cognia/agent-config-types"
import { useSettingsStore } from "@/stores/settings"
import {
  CARTESIA_TTS_VOICES,
  DEEPGRAM_TTS_VOICES,
  EDGE_TTS_VOICES,
  ELEVENLABS_TTS_VOICES,
  GEMINI_TTS_VOICES,
  HUME_TTS_VOICES,
  LMNT_TTS_VOICES,
  OPENAI_TTS_VOICES,
  ORDERED_TTS_PROVIDERS,
  XIAOMI_TTS_VOICES,
  type TTSProvider,
} from "@cognia/tts/types"
import { SPEECH_LANGUAGES } from "@cognia/tts/speech"

/**
 * Per-provider voice config — maps each provider to its flat AppSettings voice
 * key, the selectable voice catalogue (or `null` for the system provider, whose
 * voices come from the Web Speech API at runtime), and the default voice id.
 * Mirrors the desktop `provider-config.tsx` defaults exactly.
 */
const VOICE_CONFIG: Partial<
  Record<
    TTSProvider,
    {
      key: keyof AppSettings
      voices: readonly { id: string; name: string }[] | null
      fallback: string
    }
  >
> = {
  system: { key: "systemVoice", voices: null, fallback: "" },
  openai: { key: "openaiVoice", voices: OPENAI_TTS_VOICES, fallback: "alloy" },
  gemini: { key: "geminiVoice", voices: GEMINI_TTS_VOICES, fallback: "Kore" },
  edge: { key: "edgeVoice", voices: EDGE_TTS_VOICES, fallback: "en-US-JennyNeural" },
  elevenlabs: { key: "elevenlabsVoice", voices: ELEVENLABS_TTS_VOICES, fallback: "rachel" },
  lmnt: { key: "lmntVoice", voices: LMNT_TTS_VOICES, fallback: "lily" },
  hume: { key: "humeVoice", voices: HUME_TTS_VOICES, fallback: "kora" },
  cartesia: {
    key: "cartesiaVoice",
    voices: CARTESIA_TTS_VOICES,
    fallback: "a0e99841-438c-4a64-b679-ae501e7d6091",
  },
  deepgram: { key: "deepgramVoice", voices: DEEPGRAM_TTS_VOICES, fallback: "aura-2-asteria-en" },
  xiaomi: { key: "xiaomiVoice", voices: XIAOMI_TTS_VOICES, fallback: "mimo_default" },
}

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
  provider: TTSProvider
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

  const cfg = VOICE_CONFIG[provider]
  const options =
    provider === "system"
      ? [{ id: "auto", name: autoLabel }, ...systemVoices]
      : (cfg?.voices ?? []).map((v) => ({ id: v.id, name: v.name }))
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
  const update = useSettingsPatch()

  const ttsEnabled = settings?.ttsEnabled ?? false
  const ttsProvider = settings?.ttsProvider ?? "system"
  const ttsRate = settings?.ttsRate ?? 1
  const ttsPitch = settings?.ttsPitch ?? 1
  const ttsVolume = settings?.ttsVolume ?? 1
  const ttsAutoPlay = settings?.ttsAutoPlay ?? false
  const sttLanguage = settings?.sttLanguage ?? "auto"

  const voiceCfg = VOICE_CONFIG[ttsProvider as TTSProvider]
  const currentVoice = voiceCfg
    ? ((settings?.[voiceCfg.key] as string | undefined) ?? voiceCfg.fallback)
    : ""

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

          {voiceCfg && (
            <Item size="sm" className="px-0">
              <ItemContent>
                <ItemTitle className="text-xs">{t("voice")}</ItemTitle>
                <ItemDescription className="text-[11px]">{t("voiceHelp")}</ItemDescription>
                <VoiceSelect
                  provider={ttsProvider as TTSProvider}
                  value={currentVoice}
                  onChange={(v) => void update({ [voiceCfg.key]: v } as Partial<AppSettings>)}
                  disabled={!ttsEnabled}
                  ariaLabel={t("voice")}
                  autoLabel={t("voiceAuto")}
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
