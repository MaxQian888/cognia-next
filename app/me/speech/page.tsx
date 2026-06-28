"use client"

/**
 * Mobile Speech & voice page — text-to-speech master toggle, provider, the
 * common rate/pitch/volume controls, auto-play, and the speech-to-text
 * language. Every field here is already in the `app_settings_update`
 * allowlist (`APP_SETTINGS_MOBILE_ALLOWED_KEYS`, `companion_api/rpc.rs`), so
 * writes sync to the desktop the same way the rest of `/me/*` does.
 *
 * Same plumbing as `app/me/preferences/page.tsx`: optimistic `save()` into the
 * local Dexie settings row + an enqueued `app_settings_update` command so the
 * desktop reconciles on the next sync. Cloud-provider API keys are NOT writable
 * from mobile (not allowlisted) — they stay configured on desktop and the
 * provider choice merely selects which configured voice to use.
 */

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
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import type { AppSettings } from "@/lib/claude/types"
import { useSettingsStore } from "@/stores/settings"

/** TTS providers (mirrors the union in `lib/claude/types.ts`). */
const TTS_PROVIDERS = [
  "system",
  "openai",
  "gemini",
  "edge",
  "elevenlabs",
  "lmnt",
  "hume",
  "cartesia",
  "deepgram",
  "xiaomi",
] as const

/** STT language presets — `auto` clears the override (provider auto-detect). */
const STT_LANGUAGES = [
  "auto",
  "en-US",
  "zh-CN",
  "ja-JP",
  "ko-KR",
  "fr-FR",
  "de-DE",
  "es-ES",
] as const

export default function MobileSpeechPage() {
  const t = useTranslations("mobile.speech")
  const tPanel = useTranslations("mobile.settingsPanel")

  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const ttsEnabled = settings?.ttsEnabled ?? false
  const ttsProvider = settings?.ttsProvider ?? "system"
  const ttsRate = settings?.ttsRate ?? 1
  const ttsPitch = settings?.ttsPitch ?? 1
  const ttsVolume = settings?.ttsVolume ?? 1
  const ttsAutoPlay = settings?.ttsAutoPlay ?? false
  const sttLanguage = settings?.sttLanguage ?? "auto"

  const update = async (patch: Partial<AppSettings>) => {
    await save(patch as never)
    const keys = Object.keys(patch ?? {}).join(", ")
    await enqueue({
      command: "app_settings_update",
      payload: { patch },
      label: tPanel("queueLabel", { keys }),
    })
  }

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
                  {TTS_PROVIDERS.map((id) => (
                    <SelectItem key={id} value={id}>
                      {t(`providers.${id}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ItemContent>
          </Item>

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
