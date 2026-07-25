"use client"

import { AudioWaveformIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useSettingsStore } from "@/stores/settings"
import { REALTIME_TTS_MODELS, REALTIME_TTS_VOICES } from "@cognia/tts/types"
import { ApiKeyInput } from "./api-key-input"

export function LiveVoiceCard() {
  const t = useTranslations("settings.speech.live")
  const settings = useSettingsStore((store) => store.settings)
  const save = useSettingsStore((store) => store.save)
  const model = settings?.realtimeModel ?? "gpt-realtime-2.1"
  const voice = settings?.realtimeVoice ?? "marin"
  const instructions = settings?.realtimeInstructions ?? ""

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <AudioWaveformIcon className="size-4 text-primary" />
          {t("title")}
        </CardTitle>
        <CardDescription className="text-xs">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ApiKeyInput provider="openai" label={t("apiKey")} />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>{t("model")}</Label>
            <Select value={model} onValueChange={(value) => void save({ realtimeModel: value })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REALTIME_TTS_MODELS.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>{t("voice")}</Label>
            <Select value={voice} onValueChange={(value) => void save({ realtimeVoice: value })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REALTIME_TTS_VOICES.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="live-voice-instructions">{t("instructions")}</Label>
          <Textarea
            id="live-voice-instructions"
            onChange={(event) => void save({ realtimeInstructions: event.target.value })}
            placeholder={t("instructionsPlaceholder")}
            value={instructions}
          />
          <p className="text-xs text-muted-foreground">{t("privacy")}</p>
        </div>
      </CardContent>
    </Card>
  )
}
