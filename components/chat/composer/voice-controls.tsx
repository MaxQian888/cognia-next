"use client"

// Composer voice controls — a hold-to-talk SpeechInput button plus a
// compact settings popover for picking the microphone and the
// recognition language. Persists choices to AppSettings.
//
// Web Speech API path only. Browsers without Speech Recognition (Firefox,
// Safari) get a disabled button per AI Elements default; we don't ship a
// transcription backend in this app.

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { AudioLinesIcon, LanguagesIcon, Settings2Icon } from "lucide-react"
import { toast } from "sonner"
import {
  MicSelector,
  MicSelectorContent,
  MicSelectorEmpty,
  MicSelectorInput,
  MicSelectorItem,
  MicSelectorLabel,
  MicSelectorList,
  MicSelectorRequestAccess,
  MicSelectorTrigger,
  MicSelectorValue,
} from "@/components/ai-elements/mic-selector"
import { SpeechInput } from "@/components/ai-elements/speech-input"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useSettingsStore } from "@/stores/settings"
import {
  DEFAULT_SPEECH_LANGUAGE,
  SPEECH_LANGUAGES,
  type SpeechLanguageCode,
} from "@cognia/tts/speech"
import { cn } from "@/lib/utils"
import { LiveVoiceDialog } from "./live-voice-dialog"

interface VoiceControlsProps {
  onTranscription: (text: string) => void
  disabled?: boolean
}

export function VoiceControls({ onTranscription, disabled }: VoiceControlsProps) {
  const t = useTranslations("chat.composer.voice")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const language = (settings?.sttLanguage ?? DEFAULT_SPEECH_LANGUAGE) as SpeechLanguageCode
  const selectedMicId = settings?.selectedMicId

  // Mirror persisted values into local state for snappy UI (save() awaits IO
  // before updating the store). When the persisted value changes externally
  // (load, sync from another window), reset the mirror — done via
  // store-prev-value comparison during render, the React-recommended pattern
  // (https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  const [mic, setMic] = useState<string | undefined>(selectedMicId)
  const [lang, setLang] = useState<SpeechLanguageCode>(language)
  const [prevSelectedMicId, setPrevSelectedMicId] = useState<string | undefined>(selectedMicId)
  const [prevLanguage, setPrevLanguage] = useState<SpeechLanguageCode>(language)

  if (prevSelectedMicId !== selectedMicId) {
    setPrevSelectedMicId(selectedMicId)
    setMic(selectedMicId)
  }
  if (prevLanguage !== language) {
    setPrevLanguage(language)
    setLang(language)
  }

  const onMicChange = useCallback(
    (next: string | undefined) => {
      setMic(next)
      void save({ selectedMicId: next })
    },
    [save]
  )

  const onLangChange = useCallback(
    (next: string) => {
      const code = next as SpeechLanguageCode
      setLang(code)
      void save({ sttLanguage: code })
    },
    [save]
  )

  // Recording state surfaced by SpeechInput — drives the red button style,
  // the pulsing "listening" pill, and the aria labels.
  const [listening, setListening] = useState(false)

  const onSpeechError = useCallback(
    (error: string) => {
      if (error === "not-allowed" || error === "service-not-allowed") {
        toast.error(t("errors.permissionDenied"))
      } else if (error === "no-speech") {
        toast.info(t("errors.noSpeech"))
      } else if (error === "audio-capture") {
        toast.error(t("errors.noMicrophone"))
      } else {
        toast.error(t("errors.generic"))
      }
    },
    [t]
  )

  const speechLabel = listening ? t("stopListening") : t("startListening")

  return (
    <div className="flex items-center gap-1">
      {listening && (
        <span
          aria-live="polite"
          role="status"
          className="flex items-center gap-1.5 rounded-pill bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive"
        >
          <span className="relative flex size-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-destructive" />
          </span>
          {t("listening")}
        </span>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <SpeechInput
            aria-label={speechLabel}
            className={cn(
              "size-8! rounded-md! shadow-none! data-[disabled=true]:opacity-50",
              listening
                ? "bg-destructive! text-white! hover:bg-destructive/80! hover:text-white!"
                : "bg-transparent! text-muted-foreground! hover:bg-accent! hover:text-foreground!"
            )}
            disabled={disabled}
            lang={lang}
            onError={onSpeechError}
            onListeningChange={setListening}
            onTranscriptionChange={onTranscription}
            size="icon-sm"
            type="button"
            variant="ghost"
          />
        </TooltipTrigger>
        <TooltipContent>{speechLabel}</TooltipContent>
      </Tooltip>

      <LiveVoiceDialog disabled={disabled} onUserTranscript={onTranscription} />

      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button
                aria-label={t("voiceSettings")}
                className="size-8 shrink-0"
                disabled={disabled}
                size="icon"
                type="button"
                variant="ghost"
              >
                <Settings2Icon className="size-4" />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>{t("voiceSettings")}</TooltipContent>
        </Tooltip>

        <PopoverContent align="end" side="top" className="w-72 space-y-4 p-4">
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <AudioLinesIcon className="size-3.5" />
              {t("microphoneLabel")}
            </div>
            <MicSelector onValueChange={onMicChange} value={mic}>
              <MicSelectorTrigger
                aria-label={t("selectMicAria")}
                className={cn("h-9 w-full justify-between gap-2 px-3 text-left text-xs")}
                size="sm"
                variant="outline"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <AudioLinesIcon className="size-3.5 shrink-0" />
                  <MicSelectorValue />
                </div>
              </MicSelectorTrigger>
              <MicSelectorContent>
                <MicSelectorInput />
                <MicSelectorList>
                  {(devices, permission) => (
                    <>
                      {devices.length > 0 ? (
                        devices.map((device) => (
                          <MicSelectorItem key={device.deviceId} value={device.deviceId}>
                            <MicSelectorLabel device={device} />
                          </MicSelectorItem>
                        ))
                      ) : (
                        <MicSelectorEmpty>{t("noMicFound")}</MicSelectorEmpty>
                      )}
                      {permission.state === "denied" ? (
                        <p className="px-3 py-2 text-xs text-muted-foreground">
                          {t("micPermissionDenied")}
                        </p>
                      ) : (
                        permission.state !== "granted" &&
                        devices.every((device) => !device.label) && (
                          <MicSelectorRequestAccess>
                            <AudioLinesIcon className="size-3.5" />
                            {t("grantMicAccess")}
                          </MicSelectorRequestAccess>
                        )
                      )}
                    </>
                  )}
                </MicSelectorList>
              </MicSelectorContent>
            </MicSelector>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <LanguagesIcon className="size-3.5" />
              {t("languageLabel")}
            </div>
            <Select onValueChange={onLangChange} value={lang}>
              <SelectTrigger className="h-9 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SPEECH_LANGUAGES.map((item) => (
                  <SelectItem key={item.code} value={item.code}>
                    <span className="mr-2">{item.flag}</span>
                    {item.name}
                    <span className="ml-2 text-muted-foreground">{item.code}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
