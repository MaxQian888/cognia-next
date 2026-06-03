"use client"

import { Loader2, Play, Square } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { useTTS } from "@/hooks/media"
import { useSettingsStore } from "@/stores/settings"
import { loggers } from "@/lib/logging"
import type { SpeechSettings } from "@/types/media/tts"

interface TestTtsButtonProps {
  /**
   * Per-character voice overlay to audition instead of the global settings
   * (see `resolveCharacterVoice`). When omitted, the button uses the active
   * AppSettings voice — its original behaviour.
   */
  voiceOverlay?: Partial<SpeechSettings>
  /** Override the spoken sample. Defaults to a language-aware sample line. */
  sampleText?: string
}

/**
 * "Test voice" button. Speaks a language-aware sample using the active
 * settings → provider → voice → speed, allowing the user to audition
 * configuration before committing. Pass `voiceOverlay` to audition a
 * character's `voiceProfile` without touching global settings.
 */
export function TestTtsButton({ voiceOverlay, sampleText }: TestTtsButtonProps = {}) {
  const t = useTranslations("settings.speech.tts")
  const sttLanguage = useSettingsStore((s) => s.settings?.sttLanguage ?? "en-US")
  const { speak, stop, isPlaying, isLoading } = useTTS({ source: "settings", voiceOverlay })

  const handleClick = () => {
    if (isPlaying) {
      loggers.tts.info("settings.testVoice.stopped")
      stop()
      return
    }
    const sample =
      sampleText ??
      (sttLanguage.startsWith("zh")
        ? t("sample.zh")
        : sttLanguage.startsWith("ja")
          ? t("sample.ja")
          : sttLanguage.startsWith("ko")
            ? t("sample.ko")
            : t("sample.en"))
    loggers.tts.info("settings.testVoice.requested", { lang: sttLanguage })
    void speak(sample)
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={handleClick} disabled={isLoading}>
      {isLoading ? (
        <Loader2 className="size-4 animate-spin" />
      ) : isPlaying ? (
        <Square className="size-4" />
      ) : (
        <Play className="size-4" />
      )}
      <span className="ml-2">
        {isLoading ? t("loading") : isPlaying ? t("stop") : t("testVoice")}
      </span>
    </Button>
  )
}
