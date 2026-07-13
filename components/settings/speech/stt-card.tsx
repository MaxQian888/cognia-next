"use client"

import { useEffect, useState } from "react"
import { MicIcon } from "lucide-react"
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
import { Badge } from "@/components/ui/badge"
import { useSettingsStore } from "@/stores/settings"
import {
  DEFAULT_SPEECH_LANGUAGE,
  SPEECH_LANGUAGES,
  type SpeechLanguageCode,
} from "@cognia/tts/speech"
import { loggers } from "@cognia/logging"

type MicDevice = { deviceId: string; label: string }

/**
 * Speech-to-text card — configures the language used by the composer's
 * voice-input controls and the preferred microphone. Web Speech API
 * support is detected at mount.
 */
export function SttCard() {
  const t = useTranslations("settings.speech.stt")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const sttLanguage =
    (settings?.sttLanguage as SpeechLanguageCode | undefined) ?? DEFAULT_SPEECH_LANGUAGE
  const selectedMicId = settings?.selectedMicId

  const [supported] = useState<boolean | null>(() =>
    typeof window === "undefined"
      ? null
      : "SpeechRecognition" in window || "webkitSpeechRecognition" in window
  )
  const [mics, setMics] = useState<MicDevice[]>([])

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices) return
    const fallbackLabel = t("microphone")
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        setMics(
          devices
            .filter((d) => d.kind === "audioinput" && d.deviceId)
            .map((d) => ({ deviceId: d.deviceId, label: d.label || fallbackLabel }))
        )
      })
      .catch(() => setMics([]))
  }, [t])

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <MicIcon className="size-4 text-muted-foreground" />
          {t("title")}
          {supported === false && (
            <Badge variant="destructive" className="text-[10px]">
              {t("notSupported")}
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="text-xs">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label className="text-sm">{t("language")}</Label>
          <Select
            value={sttLanguage}
            onValueChange={(value) => {
              loggers.tts.info("settings.sttLanguageChanged", { language: value })
              void save({ sttLanguage: value as SpeechLanguageCode })
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SPEECH_LANGUAGES.map((lang) => (
                <SelectItem key={lang.code} value={lang.code}>
                  <span className="mr-2">{lang.flag}</span>
                  {lang.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label className="text-sm">{t("microphone")}</Label>
          <Select
            value={selectedMicId ?? "default"}
            onValueChange={(value) => {
              loggers.tts.info("settings.micChanged", { micId: value === "default" ? null : value })
              void save({
                selectedMicId: value === "default" ? undefined : value,
              })
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder={t("systemDefault")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">{t("systemDefault")}</SelectItem>
              {mics.map((m) => (
                <SelectItem key={m.deviceId} value={m.deviceId}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {mics.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("micPermissionHint")}</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
