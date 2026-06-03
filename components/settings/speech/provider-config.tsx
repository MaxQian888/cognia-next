"use client"

/**
 * Per-provider configuration cards. Each component reads its sub-slice of
 * AppSettings from the settings store and writes back via `save({...})`.
 *
 * Lives in a single file because each card is small and they share the same
 * shadcn primitives — splitting would multiply boilerplate without benefit.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Textarea } from "@/components/ui/textarea"
import { useSettingsStore } from "@/stores/settings"
import {
  CARTESIA_TTS_MODELS,
  CARTESIA_TTS_VOICES,
  DEEPGRAM_TTS_VOICES,
  EDGE_TTS_VOICES,
  ELEVENLABS_TTS_MODELS,
  ELEVENLABS_TTS_VOICES,
  GEMINI_TTS_VOICES,
  HUME_TTS_VOICES,
  LMNT_TTS_VOICES,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  XIAOMI_TTS_VOICES,
  XIAOMI_TTS_MODELS,
  XIAOMI_TTS_STYLES,
} from "@/types/media/tts"
import { ApiKeyInput } from "./api-key-input"

// -- Generic helper for a labelled slider value ------------------------------

function NumberSlider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (n: number) => void
  format?: (n: number) => string
}) {
  const { label, value, min, max, step, onChange, format } = props
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <span className="text-xs text-muted-foreground tabular-nums">
          {format ? format(value) : value.toFixed(2)}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(v[0])}
      />
    </div>
  )
}

// -- System ------------------------------------------------------------------

export function SystemConfig() {
  const t = useTranslations("settings.speech.provider")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return
    const load = () => setVoices(speechSynthesis.getVoices())
    load()
    speechSynthesis.onvoiceschanged = load
    return () => {
      speechSynthesis.onvoiceschanged = null
    }
  }, [])

  const value = settings?.systemVoice ?? ""

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label className="text-xs">{t("voice")}</Label>
        <Select
          value={value || "auto"}
          onValueChange={(v) => void save({ systemVoice: v === "auto" ? "" : v })}
        >
          <SelectTrigger>
            <SelectValue placeholder={t("voiceAutoPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t("voiceAuto")}</SelectItem>
            {voices.map((v) => (
              <SelectItem key={v.voiceURI} value={v.voiceURI}>
                {v.name} ({v.lang})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {voices.length === 0 && (
          <p className="text-xs text-muted-foreground">{t("voicesLoading")}</p>
        )}
      </div>
    </div>
  )
}

// -- OpenAI ------------------------------------------------------------------

const OPENAI_RESPONSE_FORMATS = [
  { id: "mp3", name: "MP3" },
  { id: "opus", name: "Opus" },
  { id: "aac", name: "AAC" },
  { id: "flac", name: "FLAC" },
  { id: "wav", name: "WAV" },
  { id: "pcm", name: "PCM" },
] as const

export function OpenAiConfig() {
  const t = useTranslations("settings.speech.provider")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const voice = settings?.openaiVoice ?? "alloy"
  const model = settings?.openaiModel ?? "gpt-4o-mini-tts"
  const speed = settings?.openaiSpeed ?? 1.0
  const instructions = settings?.openaiInstructions ?? ""
  const responseFormat = settings?.openaiResponseFormat ?? "mp3"

  return (
    <div className="space-y-3">
      <ApiKeyInput provider="openai" label={t("label.openai")} placeholder="sk-…" />
      <div className="space-y-2">
        <Label className="text-xs">{t("voice")}</Label>
        <Select value={voice} onValueChange={(v) => void save({ openaiVoice: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPENAI_TTS_VOICES.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.name} — {v.description}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label className="text-xs">{t("model")}</Label>
        <Select value={model} onValueChange={(v) => void save({ openaiModel: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPENAI_TTS_MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name} — {m.description}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label className="text-xs">{t("audioFormat")}</Label>
        <Select
          value={responseFormat}
          onValueChange={(v) => void save({ openaiResponseFormat: v })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPENAI_RESPONSE_FORMATS.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <NumberSlider
        label={t("speed")}
        value={speed}
        min={0.25}
        max={4.0}
        step={0.05}
        onChange={(n) => void save({ openaiSpeed: n })}
        format={(n) => `${n.toFixed(2)}x`}
      />
      {model === "gpt-4o-mini-tts" && (
        <div className="space-y-2">
          <Label className="text-xs">{t("voiceInstructions")}</Label>
          <Textarea
            value={instructions}
            onChange={(e) => void save({ openaiInstructions: e.target.value })}
            placeholder={t("voiceInstructionsPlaceholder")}
            rows={3}
          />
        </div>
      )}
    </div>
  )
}

// -- Gemini ------------------------------------------------------------------

export function GeminiConfig() {
  const t = useTranslations("settings.speech.provider")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const voice = settings?.geminiVoice ?? "Kore"

  return (
    <div className="space-y-3">
      <ApiKeyInput provider="google" label={t("label.google")} placeholder="AIza…" />
      <div className="space-y-2">
        <Label className="text-xs">{t("voice")}</Label>
        <Select value={voice} onValueChange={(v) => void save({ geminiVoice: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {GEMINI_TTS_VOICES.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.name} — {v.description}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

// -- Edge --------------------------------------------------------------------

export function EdgeConfig() {
  const t = useTranslations("settings.speech.provider")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const voice = settings?.edgeVoice ?? "en-US-JennyNeural"
  const rate = settings?.edgeRate ?? "+0%"
  const pitch = settings?.edgePitch ?? "+0Hz"
  const sttLang = (settings?.sttLanguage ?? "en-US").split("-")[0]

  // Filter by app language for usability; fall back to all if no match.
  const filtered = EDGE_TTS_VOICES.filter((v) => v.language.startsWith(sttLang))
  const list = filtered.length > 0 ? filtered : EDGE_TTS_VOICES

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("edgeIntro")}</p>
      <div className="space-y-2">
        <Label className="text-xs">{t("voice")}</Label>
        <Select value={voice} onValueChange={(v) => void save({ edgeVoice: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {list.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.name} — {v.language} ({v.gender})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">{t("edgeRate")}</Label>
          <Input
            value={rate}
            onChange={(e) => void save({ edgeRate: e.target.value })}
            placeholder="+0%"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t("edgePitch")}</Label>
          <Input
            value={pitch}
            onChange={(e) => void save({ edgePitch: e.target.value })}
            placeholder="+0Hz"
          />
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground">
        {t("edgeFormatHintBefore")}
        <code>+/-N%</code>
        {t("edgeFormatHintMid")}
        <code>+/-NHz</code>
        {t("edgeFormatHintAfter")}
      </p>
    </div>
  )
}

// -- ElevenLabs --------------------------------------------------------------

export function ElevenLabsConfig() {
  const t = useTranslations("settings.speech.provider")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const voice = settings?.elevenlabsVoice ?? "rachel"
  const model = settings?.elevenlabsModel ?? "eleven_multilingual_v2"
  const stability = settings?.elevenlabsStability ?? 0.5
  const similarityBoost = settings?.elevenlabsSimilarityBoost ?? 0.75

  return (
    <div className="space-y-3">
      <ApiKeyInput provider="elevenlabs" label={t("label.elevenlabs")} placeholder="sk_…" />
      <div className="space-y-2">
        <Label className="text-xs">{t("voice")}</Label>
        <Select value={voice} onValueChange={(v) => void save({ elevenlabsVoice: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ELEVENLABS_TTS_VOICES.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.name} — {v.description}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label className="text-xs">{t("model")}</Label>
        <Select value={model} onValueChange={(v) => void save({ elevenlabsModel: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ELEVENLABS_TTS_MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name} — {m.description}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <NumberSlider
        label={t("elevenStability")}
        value={stability}
        min={0}
        max={1}
        step={0.05}
        onChange={(n) => void save({ elevenlabsStability: n })}
      />
      <NumberSlider
        label={t("elevenSimilarity")}
        value={similarityBoost}
        min={0}
        max={1}
        step={0.05}
        onChange={(n) => void save({ elevenlabsSimilarityBoost: n })}
      />
    </div>
  )
}

// -- LMNT --------------------------------------------------------------------

export function LmntConfig() {
  const t = useTranslations("settings.speech.provider")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const voice = settings?.lmntVoice ?? "lily"
  const speed = settings?.lmntSpeed ?? 1.0

  return (
    <div className="space-y-3">
      <ApiKeyInput provider="lmnt" label={t("label.lmnt")} />
      <div className="space-y-2">
        <Label className="text-xs">{t("voice")}</Label>
        <Select value={voice} onValueChange={(v) => void save({ lmntVoice: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LMNT_TTS_VOICES.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.name} — {v.description}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <NumberSlider
        label={t("speed")}
        value={speed}
        min={0.5}
        max={2.0}
        step={0.05}
        onChange={(n) => void save({ lmntSpeed: n })}
        format={(n) => `${n.toFixed(2)}x`}
      />
    </div>
  )
}

// -- Hume --------------------------------------------------------------------

export function HumeConfig() {
  const t = useTranslations("settings.speech.provider")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const voice = settings?.humeVoice ?? "kora"

  return (
    <div className="space-y-3">
      <ApiKeyInput provider="hume" label={t("label.hume")} />
      <div className="space-y-2">
        <Label className="text-xs">{t("voice")}</Label>
        <Select value={voice} onValueChange={(v) => void save({ humeVoice: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {HUME_TTS_VOICES.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.name} — {v.description}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

// -- Cartesia ----------------------------------------------------------------

const CARTESIA_EMOTION_PRESETS = [
  { id: "positivity:high", label: "Positive" },
  { id: "sadness:high", label: "Sad" },
  { id: "anger:high", label: "Angry" },
  { id: "surprise:high", label: "Surprised" },
  { id: "fear:high", label: "Fearful" },
  { id: "positivity:medium", label: "Warm" },
  { id: "sadness:medium", label: "Melancholy" },
  { id: "curiosity:high", label: "Curious" },
] as const

export function CartesiaConfig() {
  const t = useTranslations("settings.speech.provider")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const voice = settings?.cartesiaVoice ?? "a0e99841-438c-4a64-b679-ae501e7d6091"
  const model = settings?.cartesiaModel ?? "sonic-3"
  const language = settings?.cartesiaLanguage ?? "en"
  const speed = settings?.cartesiaSpeed ?? 0
  const emotion = settings?.cartesiaEmotion ?? ""

  return (
    <div className="space-y-3">
      <ApiKeyInput provider="cartesia" label={t("label.cartesia")} />
      <div className="space-y-2">
        <Label className="text-xs">{t("voice")}</Label>
        <Select value={voice} onValueChange={(v) => void save({ cartesiaVoice: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CARTESIA_TTS_VOICES.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.name} — {v.description}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label className="text-xs">{t("model")}</Label>
        <Select value={model} onValueChange={(v) => void save({ cartesiaModel: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CARTESIA_TTS_MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name} — {m.description}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">{t("cartesiaLanguage")}</Label>
        <Input
          value={language}
          onChange={(e) => void save({ cartesiaLanguage: e.target.value })}
          placeholder="en"
        />
      </div>
      <div className="space-y-2">
        <Label className="text-xs">{t("cartesiaEmotion")}</Label>
        <div className="flex flex-wrap gap-1.5">
          {CARTESIA_EMOTION_PRESETS.map((e) => (
            <Badge
              key={e.id}
              variant={emotion === e.id ? "default" : "outline"}
              className="cursor-pointer text-xs hover:bg-primary/10"
              onClick={() => void save({ cartesiaEmotion: emotion === e.id ? "" : e.id })}
            >
              {e.label}
            </Badge>
          ))}
        </div>
        <Input
          value={emotion}
          onChange={(e) => void save({ cartesiaEmotion: e.target.value })}
          placeholder={t("cartesiaEmotionPlaceholder")}
        />
      </div>
      <NumberSlider
        label={t("speed")}
        value={speed}
        min={-1.0}
        max={1.0}
        step={0.05}
        onChange={(n) => void save({ cartesiaSpeed: n })}
        format={(n) => n.toFixed(2)}
      />
    </div>
  )
}

// -- Deepgram ----------------------------------------------------------------

export function DeepgramConfig() {
  const t = useTranslations("settings.speech.provider")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const voice = settings?.deepgramVoice ?? "aura-2-asteria-en"

  return (
    <div className="space-y-3">
      <ApiKeyInput provider="deepgram" label={t("label.deepgram")} />
      <div className="space-y-2">
        <Label className="text-xs">{t("voice")}</Label>
        <Select value={voice} onValueChange={(v) => void save({ deepgramVoice: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DEEPGRAM_TTS_VOICES.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.name} — {v.description}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

// -- Xiaomi ------------------------------------------------------------------

export function XiaomiConfig() {
  const t = useTranslations("settings.speech.provider")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const voice = settings?.xiaomiVoice ?? "mimo_default"
  const model = settings?.xiaomiModel ?? "mimo-v2-tts"
  const style = settings?.xiaomiStyle ?? ""
  const dialect = settings?.xiaomiDialect ?? ""

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("xiaomiIntro")}</p>
      <ApiKeyInput provider="xiaomi" label={t("label.xiaomi")} placeholder="sk-…" />
      <div className="space-y-2">
        <Label className="text-xs">{t("voice")}</Label>
        <Select value={voice} onValueChange={(v) => void save({ xiaomiVoice: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {XIAOMI_TTS_VOICES.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.name} — {v.description}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label className="text-xs">{t("model")}</Label>
        <Select value={model} onValueChange={(v) => void save({ xiaomiModel: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {XIAOMI_TTS_MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name} — {m.description}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label className="text-xs">{t("xiaomiStyle")}</Label>
        <div className="flex flex-wrap gap-1.5">
          {XIAOMI_TTS_STYLES.map((s) => (
            <Badge
              key={s.id}
              variant={style === s.id ? "default" : "outline"}
              className="cursor-pointer text-xs hover:bg-primary/10"
              onClick={() => void save({ xiaomiStyle: style === s.id ? "" : s.id })}
            >
              {s.tag}
            </Badge>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground">{t("xiaomiStyleHint")}</p>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">{t("xiaomiDialect")}</Label>
        <Input
          value={dialect}
          onChange={(e) => void save({ xiaomiDialect: e.target.value })}
          placeholder={t("xiaomiDialectPlaceholder")}
        />
      </div>
    </div>
  )
}

// -- Mapping -----------------------------------------------------------------

import type { TTSProvider } from "@/types/media/tts"

export const PROVIDER_CONFIG_COMPONENTS: Record<TTSProvider, () => React.ReactElement> = {
  system: SystemConfig,
  openai: OpenAiConfig,
  gemini: GeminiConfig,
  edge: EdgeConfig,
  elevenlabs: ElevenLabsConfig,
  lmnt: LmntConfig,
  hume: HumeConfig,
  cartesia: CartesiaConfig,
  deepgram: DeepgramConfig,
  xiaomi: XiaomiConfig,
}
