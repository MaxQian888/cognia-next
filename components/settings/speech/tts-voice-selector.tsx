"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import {
  VoiceSelector,
  VoiceSelectorAttributes,
  VoiceSelectorContent,
  VoiceSelectorDescription,
  VoiceSelectorEmpty,
  VoiceSelectorGender,
  VoiceSelectorGroup,
  VoiceSelectorInput,
  VoiceSelectorItem,
  VoiceSelectorList,
  VoiceSelectorName,
  VoiceSelectorPreview,
  VoiceSelectorTrigger,
} from "@/components/ai-elements/voice-selector"
import { Button } from "@/components/ui/button"
import { useTTS } from "@/hooks/media"
import { useSettingsStore } from "@/stores/settings"
import type { SpeechSettings } from "@cognia/tts/types"

export interface TtsVoiceOption {
  id: string
  name: string
  description?: string
  language?: string
  gender?: string
}

interface TtsVoiceSelectorProps {
  value: string
  options: readonly TtsVoiceOption[]
  onValueChange: (value: string) => void
  getVoiceOverlay?: (voiceId: string) => Partial<SpeechSettings>
  autoOption?: TtsVoiceOption
  disabled?: boolean
}

function normalizeGender(gender?: string) {
  const value = gender?.toLowerCase()
  return value === "male" || value === "female" ? value : undefined
}

export function TtsVoiceSelector({
  value,
  options,
  onValueChange,
  getVoiceOverlay,
  autoOption,
  disabled,
}: TtsVoiceSelectorProps) {
  const t = useTranslations("settings.speech.provider")
  const tTts = useTranslations("settings.speech.tts")
  const sttLanguage = useSettingsStore((state) => state.settings?.sttLanguage ?? "en-US")
  const [open, setOpen] = useState(false)
  const [previewRequest, setPreviewRequest] = useState<{ id: string; nonce: number } | null>(null)
  const previewNonceRef = useRef(0)

  const allOptions = useMemo(
    () => (autoOption ? [autoOption, ...options] : [...options]),
    [autoOption, options]
  )
  const selected = allOptions.find((option) => option.id === value)
  const voiceOverlay =
    previewRequest && getVoiceOverlay ? getVoiceOverlay(previewRequest.id) : undefined
  const { speak, stop, isPlaying, isLoading } = useTTS({
    source: "settings",
    voiceOverlay,
  })

  useEffect(() => {
    if (!previewRequest || !getVoiceOverlay) return
    const sample = sttLanguage.startsWith("zh")
      ? tTts("sample.zh")
      : sttLanguage.startsWith("ja")
        ? tTts("sample.ja")
        : sttLanguage.startsWith("ko")
          ? tTts("sample.ko")
          : tTts("sample.en")
    void speak(sample)
  }, [getVoiceOverlay, previewRequest, speak, sttLanguage, tTts])

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      stop()
      setPreviewRequest(null)
    }
  }

  const handleSelect = (voiceId: string) => {
    onValueChange(voiceId)
    handleOpenChange(false)
  }

  const handlePreview = (voiceId: string) => {
    if (isPlaying && previewRequest?.id === voiceId) {
      stop()
      setPreviewRequest(null)
      return
    }
    stop()
    previewNonceRef.current += 1
    setPreviewRequest({ id: voiceId, nonce: previewNonceRef.current })
  }

  return (
    <VoiceSelector value={value} open={open} onOpenChange={handleOpenChange}>
      <VoiceSelectorTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">{selected?.name ?? value}</span>
          <ChevronsUpDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </VoiceSelectorTrigger>
      <VoiceSelectorContent title={t("voiceSelectorTitle")} className="sm:max-w-xl">
        <VoiceSelectorInput placeholder={t("voiceSearchPlaceholder")} />
        <VoiceSelectorList className="max-h-80">
          <VoiceSelectorEmpty>{t("voiceNoResults")}</VoiceSelectorEmpty>
          <VoiceSelectorGroup heading={t("voice")}>
            {allOptions.map((option) => {
              const previewing = previewRequest?.id === option.id && isPlaying
              return (
                <VoiceSelectorItem
                  key={option.id}
                  value={[option.id, option.name, option.description, option.language]
                    .filter(Boolean)
                    .join(" ")}
                  onSelect={() => handleSelect(option.id)}
                >
                  <CheckIcon
                    className={value === option.id ? "size-4" : "size-4 opacity-0"}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <VoiceSelectorName>{option.name}</VoiceSelectorName>
                      {option.gender && (
                        <VoiceSelectorGender value={normalizeGender(option.gender)} />
                      )}
                    </div>
                    {(option.description || option.language) && (
                      <VoiceSelectorAttributes className="gap-2">
                        {option.description && (
                          <VoiceSelectorDescription>{option.description}</VoiceSelectorDescription>
                        )}
                        {option.language && (
                          <VoiceSelectorDescription>{option.language}</VoiceSelectorDescription>
                        )}
                      </VoiceSelectorAttributes>
                    )}
                  </div>
                  {getVoiceOverlay && option.id !== autoOption?.id && (
                    <VoiceSelectorPreview
                      playing={previewing}
                      loading={previewRequest?.id === option.id && isLoading}
                      onPlay={() => handlePreview(option.id)}
                      aria-label={previewing ? t("voicePausePreview") : t("voicePreview")}
                    />
                  )}
                </VoiceSelectorItem>
              )
            })}
          </VoiceSelectorGroup>
        </VoiceSelectorList>
      </VoiceSelectorContent>
    </VoiceSelector>
  )
}
