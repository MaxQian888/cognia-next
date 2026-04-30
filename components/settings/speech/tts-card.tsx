"use client"

import { Volume2Icon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { useSettingsStore } from "@/stores/settings"
import { ORDERED_TTS_PROVIDERS, TTS_PROVIDERS, type TTSProvider } from "@/lib/tts/types"
import { TestTtsButton } from "./test-tts-button"
import { PROVIDER_CONFIG_COMPONENTS } from "./provider-config"
import { loggers } from "@/lib/logger"

/**
 * Text-to-speech card. Shows the master toggle, provider switch, the
 * provider-specific config sub-panel, then the global rate/pitch/volume
 * controls + auto-play / cache toggles.
 */
export function TtsCard() {
  const t = useTranslations("settings.speech.tts")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const setTtsEnabled = useSettingsStore((s) => s.setTtsEnabled)
  const setTtsProvider = useSettingsStore((s) => s.setTtsProvider)
  const setTtsAutoPlay = useSettingsStore((s) => s.setTtsAutoPlay)
  const setTtsRate = useSettingsStore((s) => s.setTtsRate)
  const setTtsPitch = useSettingsStore((s) => s.setTtsPitch)
  const setTtsVolume = useSettingsStore((s) => s.setTtsVolume)

  const ttsEnabled = settings?.ttsEnabled ?? false
  const provider: TTSProvider = (settings?.ttsProvider ?? "system") as TTSProvider
  const ttsAutoPlay = settings?.ttsAutoPlay ?? false
  const ttsRate = settings?.ttsRate ?? 1.0
  const ttsPitch = settings?.ttsPitch ?? 1.0
  const ttsVolume = settings?.ttsVolume ?? 1.0
  const ttsCacheEnabled = settings?.ttsCacheEnabled ?? true
  const ttsStreamingEnabled = settings?.ttsStreamingEnabled ?? true

  const ProviderConfig = PROVIDER_CONFIG_COMPONENTS[provider]
  const info = TTS_PROVIDERS[provider]

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Volume2Icon className="size-4 text-muted-foreground" />
          {t("title")}
        </CardTitle>
        <CardDescription className="text-xs">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Master toggle */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label className="text-sm">{t("enable")}</Label>
            <p className="text-xs text-muted-foreground">{t("enableHint")}</p>
          </div>
          <Switch
            checked={ttsEnabled}
            onCheckedChange={(v) => {
              loggers.tts.info("settings.ttsEnabledChanged", { enabled: v })
              void setTtsEnabled(v)
            }}
          />
        </div>

        {ttsEnabled && (
          <>
            <Separator />

            {/* Provider switch */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm">{t("provider")}</Label>
                <TestTtsButton />
              </div>
              <Select
                value={provider}
                onValueChange={(v) => {
                  loggers.tts.info("settings.ttsProviderChanged", { provider: v })
                  void setTtsProvider(v as TTSProvider)
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ORDERED_TTS_PROVIDERS.map((id) => (
                    <SelectItem key={id} value={id}>
                      {TTS_PROVIDERS[id].name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{info.description}</p>
            </div>

            <Separator />

            {/* Provider-specific config */}
            <div className="space-y-2">
              <ProviderConfig />
            </div>

            <Separator />

            {/* Global controls */}
            <div className="space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">{t("rate")}</Label>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {ttsRate.toFixed(2)}x
                  </span>
                </div>
                <Slider
                  value={[ttsRate]}
                  min={0.5}
                  max={2.0}
                  step={0.05}
                  onValueChange={(v) => void setTtsRate(v[0])}
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">{t("pitch")}</Label>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {ttsPitch.toFixed(2)}
                  </span>
                </div>
                <Slider
                  value={[ttsPitch]}
                  min={0}
                  max={2}
                  step={0.05}
                  onValueChange={(v) => void setTtsPitch(v[0])}
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">{t("volume")}</Label>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {Math.round(ttsVolume * 100)}%
                  </span>
                </div>
                <Slider
                  value={[ttsVolume]}
                  min={0}
                  max={1}
                  step={0.05}
                  onValueChange={(v) => void setTtsVolume(v[0])}
                />
              </div>
            </div>

            <Separator />

            {/* Toggles */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-sm">{t("autoPlay")}</Label>
                  <p className="text-xs text-muted-foreground">{t("autoPlayHint")}</p>
                </div>
                <Switch
                  checked={ttsAutoPlay}
                  onCheckedChange={(v) => {
                    loggers.tts.info("settings.ttsAutoPlayChanged", { enabled: v })
                    void setTtsAutoPlay(v)
                  }}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-sm">{t("cache")}</Label>
                  <p className="text-xs text-muted-foreground">{t("cacheHint")}</p>
                </div>
                <Switch
                  checked={ttsCacheEnabled}
                  onCheckedChange={(v) => {
                    loggers.tts.info("settings.ttsCacheChanged", { enabled: v })
                    void save({ ttsCacheEnabled: v })
                  }}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-sm">{t("streaming")}</Label>
                  <p className="text-xs text-muted-foreground">{t("streamingHint")}</p>
                </div>
                <Switch
                  checked={ttsStreamingEnabled}
                  onCheckedChange={(v) => {
                    loggers.tts.info("settings.ttsStreamingChanged", { enabled: v })
                    void save({ ttsStreamingEnabled: v })
                  }}
                />
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
