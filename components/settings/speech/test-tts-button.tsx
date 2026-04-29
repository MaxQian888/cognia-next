"use client"

import { Loader2, Play, Square } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useTTS } from "@/hooks/use-tts"
import { useSettingsStore } from "@/stores/settings-store"

/**
 * "Test voice" button. Speaks a language-aware sample using the active
 * settings → provider → voice → speed, allowing the user to audition
 * configuration before committing.
 */
export function TestTtsButton() {
  const sttLanguage = useSettingsStore((s) => s.settings?.sttLanguage ?? "en-US")
  const { speak, stop, isPlaying, isLoading } = useTTS({ source: "settings" })

  const handleClick = () => {
    if (isPlaying) {
      stop()
      return
    }
    const sample = sttLanguage.startsWith("zh")
      ? "你好，这是一段测试语音。"
      : sttLanguage.startsWith("ja")
        ? "こんにちは、これはテスト音声です。"
        : sttLanguage.startsWith("ko")
          ? "안녕하세요, 음성 테스트입니다."
          : "Hello, this is a test of the text-to-speech feature."
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
      <span className="ml-2">{isLoading ? "Loading…" : isPlaying ? "Stop" : "Test voice"}</span>
    </Button>
  )
}
