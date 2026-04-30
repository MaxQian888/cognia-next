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
import {
  MicSelector,
  MicSelectorContent,
  MicSelectorEmpty,
  MicSelectorInput,
  MicSelectorItem,
  MicSelectorLabel,
  MicSelectorList,
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
} from "@/lib/tts/speech"
import { cn } from "@/lib/utils"

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

  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <SpeechInput
            aria-label={t("holdToTalk")}
            className="size-8! rounded-md! bg-transparent! text-muted-foreground! shadow-none! hover:bg-accent! hover:text-foreground! data-[disabled=true]:opacity-50"
            disabled={disabled}
            lang={lang}
            onTranscriptionChange={onTranscription}
            size="icon-sm"
            type="button"
            variant="ghost"
          />
        </TooltipTrigger>
        <TooltipContent>{t("holdToTalk")}</TooltipContent>
      </Tooltip>

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
                  {(devices) =>
                    devices.length > 0 ? (
                      devices.map((device) => (
                        <MicSelectorItem key={device.deviceId} value={device.deviceId}>
                          <MicSelectorLabel device={device} />
                        </MicSelectorItem>
                      ))
                    ) : (
                      <MicSelectorEmpty />
                    )
                  }
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
