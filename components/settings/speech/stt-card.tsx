"use client"

import { useEffect, useState } from "react"
import { MicIcon } from "lucide-react"

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
import { useSettingsStore } from "@/stores/settings-store"
import { DEFAULT_SPEECH_LANGUAGE, SPEECH_LANGUAGES, type SpeechLanguageCode } from "@/lib/speech"

type MicDevice = { deviceId: string; label: string }

/**
 * Speech-to-text card — configures the language used by the composer's
 * voice-input controls and the preferred microphone. Web Speech API
 * support is detected at mount.
 */
export function SttCard() {
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
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        setMics(
          devices
            .filter((d) => d.kind === "audioinput")
            .map((d) => ({ deviceId: d.deviceId, label: d.label || "Microphone" }))
        )
      })
      .catch(() => setMics([]))
  }, [])

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <MicIcon className="size-4 text-muted-foreground" />
          Speech-to-text
          {supported === false && (
            <Badge variant="destructive" className="text-[10px]">
              Not supported
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="text-xs">
          The composer&apos;s voice-input button uses your browser&apos;s Web Speech API. Pick the
          language you usually speak and the microphone you want to use.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label className="text-sm">Language</Label>
          <Select
            value={sttLanguage}
            onValueChange={(value) => void save({ sttLanguage: value as SpeechLanguageCode })}
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
          <Label className="text-sm">Microphone</Label>
          <Select
            value={selectedMicId ?? "default"}
            onValueChange={(value) =>
              void save({
                selectedMicId: value === "default" ? undefined : value,
              })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="System default" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">System default</SelectItem>
              {mics.map((m) => (
                <SelectItem key={m.deviceId} value={m.deviceId}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {mics.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Grant microphone permission once for the device list to populate.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
