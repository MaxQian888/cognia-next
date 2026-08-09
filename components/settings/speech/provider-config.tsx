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
import { isTauri } from "@/lib/tauri"
import { HOST_KEY_PRESENT } from "@/lib/tts/keyring"
import { useSettingsStore } from "@/stores/settings"
import {
  CARTESIA_TTS_MODELS,
  CARTESIA_TTS_VOICES,
  DEEPGRAM_TTS_VOICES,
  EDGE_TTS_VOICES,
  ELEVENLABS_TTS_MODELS,
  ELEVENLABS_TTS_VOICES,
  GEMINI_TTS_VOICES,
  GEMINI_TTS_MODELS,
  HUME_TTS_VOICES,
  LMNT_TTS_VOICES,
  MISTRAL_TTS_MODELS,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  REALTIME_TTS_MODELS,
  REALTIME_TTS_VOICES,
  XIAOMI_TTS_VOICES,
  XIAOMI_TTS_MODELS,
  XIAOMI_TTS_STYLES,
} from "@cognia/tts/types"
import { listElevenLabsVoices, type ElevenLabsVoice } from "@cognia/tts/providers/elevenlabs"
import { ApiKeyInput } from "./api-key-input"
import { TtsVoiceSelector } from "./tts-voice-selector"

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
        <TtsVoiceSelector
          value={value || "auto"}
          onValueChange={(v) => void save({ systemVoice: v === "auto" ? "" : v })}
          autoOption={{ id: "auto", name: t("voiceAuto") }}
          options={voices.map((voice) => ({
            id: voice.voiceURI,
            name: voice.name,
            language: voice.lang,
          }))}
          getVoiceOverlay={(voiceId) => ({ ttsProvider: "system", systemVoice: voiceId })}
        />
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
      <ApiKeyInput
        provider="openai"
        label={t("label.openai")}
        placeholder={t("apiKeyPlaceholder.generic")}
      />
      <div className="space-y-2">
        <Label className="text-xs">{t("voice")}</Label>
        <TtsVoiceSelector
          value={voice}
          options={OPENAI_TTS_VOICES}
          onValueChange={(v) => void save({ openaiVoice: v })}
          getVoiceOverlay={(voiceId) => ({
            ttsProvider: "openai",
            openaiVoice: voiceId as (typeof OPENAI_TTS_VOICES)[number]["id"],
          })}
        />
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

// -- Local OpenAI-compatible -------------------------------------------------

export function LocalOpenAiCompatibleConfig() {
  const t = useTranslations("settings.speech.provider")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const baseUrl = settings?.localOpenaiBaseUrl ?? ""
  const model = settings?.localOpenaiModel ?? ""
  const voice = settings?.localOpenaiVoice ?? ""
  const speed = settings?.localOpenaiSpeed ?? 1
  const responseFormat = settings?.localOpenaiResponseFormat ?? "mp3"
  const timeoutMs = settings?.localOpenaiTimeoutMs ?? 60_000

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("localOpenaiIntro")}</p>
      {!isTauri() && <p className="text-xs text-destructive">{t("localEndpointHint")}</p>}
      <div className="space-y-2">
        <Label className="text-xs">{t("localEndpoint")}</Label>
        <Input
          value={baseUrl}
          onChange={(event) => void save({ localOpenaiBaseUrl: event.target.value })}
          placeholder={t("localEndpointPlaceholder")}
          spellCheck={false}
        />
        <p className="text-[10px] text-muted-foreground">{t("localEndpointHint")}</p>
      </div>
      <div className="space-y-2">
        <Label className="text-xs">{t("model")}</Label>
        <Input
          value={model}
          onChange={(event) => void save({ localOpenaiModel: event.target.value })}
          placeholder={t("localModelPlaceholder")}
          spellCheck={false}
        />
      </div>
      <div className="space-y-2">
        <Label className="text-xs">{t("voice")}</Label>
        <Input
          value={voice}
          onChange={(event) => void save({ localOpenaiVoice: event.target.value })}
          placeholder={t("localVoicePlaceholder")}
          spellCheck={false}
        />
      </div>
      <ApiKeyInput
        provider="local-openai-compatible"
        label={t("label.local-openai-compatible")}
        placeholder={t("apiKeyPlaceholder.generic")}
      />
      <div className="space-y-2">
        <Label className="text-xs">{t("audioFormat")}</Label>
        <Select
          value={responseFormat === "pcm" ? "mp3" : responseFormat}
          onValueChange={(value) => void save({ localOpenaiResponseFormat: value })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPENAI_RESPONSE_FORMATS.map((format) => (
              <SelectItem key={format.id} value={format.id}>
                {format.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <NumberSlider
        label={t("speed")}
        value={speed}
        min={0.25}
        max={4}
        step={0.05}
        onChange={(value) => void save({ localOpenaiSpeed: value })}
        format={(value) => `${value.toFixed(2)}x`}
      />
      <div className="space-y-2">
        <Label className="text-xs">{t("timeoutSeconds")}</Label>
        <Input
          type="number"
          min={1}
          max={300}
          value={Math.round(timeoutMs / 1000)}
          onChange={(event) => {
            const seconds = Number(event.target.value)
            if (Number.isFinite(seconds)) {
              void save({ localOpenaiTimeoutMs: Math.min(300, Math.max(1, seconds)) * 1000 })
            }
          }}
        />
      </div>
    </div>
  )
}

// -- Gemini ------------------------------------------------------------------

export function GeminiConfig() {
  const t = useTranslations("settings.speech.provider")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const voice = settings?.geminiVoice ?? "Kore"
  const model = settings?.geminiModel ?? "gemini-3.1-flash-tts-preview"

  return (
    <div className="space-y-3">
      <ApiKeyInput
        provider="google"
        label={t("label.google")}
        placeholder={t("apiKeyPlaceholder.google")}
      />
      <div className="space-y-2">
        <Label className="text-xs">{t("model")}</Label>
        <Select value={model} onValueChange={(v) => void save({ geminiModel: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GEMINI_TTS_MODELS.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name} — {item.description}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label className="text-xs">{t("voice")}</Label>
        <TtsVoiceSelector
          value={voice}
          options={GEMINI_TTS_VOICES}
          onValueChange={(v) => void save({ geminiVoice: v })}
          getVoiceOverlay={(voiceId) => ({
            ttsProvider: "gemini",
            geminiVoice: voiceId as (typeof GEMINI_TTS_VOICES)[number]["id"],
          })}
        />
      </div>
    </div>
  )
}

// -- Mistral -----------------------------------------------------------------

export function MistralConfig() {
  const t = useTranslations("settings.speech.provider")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const voiceId = settings?.mistralVoiceId ?? ""
  const model = settings?.mistralModel ?? "voxtral-mini-tts-2603"
  const responseFormat = settings?.mistralResponseFormat ?? "mp3"

  return (
    <div className="space-y-3">
      <ApiKeyInput provider="mistral" label={t("label.mistral")} />
      <div className="space-y-2">
        <Label className="text-xs">{t("voice")}</Label>
        <Input
          value={voiceId}
          onChange={(event) => void save({ mistralVoiceId: event.target.value })}
          placeholder={t("mistralVoiceIdPlaceholder")}
        />
        <p className="text-[10px] text-muted-foreground">{t("mistralVoiceIdHint")}</p>
      </div>
      <div className="space-y-2">
        <Label className="text-xs">{t("model")}</Label>
        <Select value={model} onValueChange={(value) => void save({ mistralModel: value })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MISTRAL_TTS_MODELS.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name} — {item.description}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label className="text-xs">{t("audioFormat")}</Label>
        <Select
          value={responseFormat}
          onValueChange={(value) => void save({ mistralResponseFormat: value })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPENAI_RESPONSE_FORMATS.filter((format) => format.id !== "aac").map((format) => (
              <SelectItem key={format.id} value={format.id}>
                {format.name}
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
        <TtsVoiceSelector
          value={voice}
          options={list}
          onValueChange={(v) => void save({ edgeVoice: v })}
          getVoiceOverlay={(voiceId) => ({
            ttsProvider: "edge",
            edgeVoice: voiceId as (typeof EDGE_TTS_VOICES)[number]["id"],
          })}
        />
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
            // i18n-exempt: locale-invariant Edge TTS pitch format literal
            placeholder="+0Hz"
          />
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground">
        {t("edgeFormatHintBefore")}
        <code>+/-N%</code>
        {t("edgeFormatHintMid")}
        {/* i18n-exempt: locale-invariant Edge TTS pitch format literal */}
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
  const storedKey = useSettingsStore((s) => s.providerKeys.elevenlabs ?? "")
  const [accountVoices, setAccountVoices] = useState<ElevenLabsVoice[]>([])

  useEffect(() => {
    if (!storedKey) return
    const controller = new AbortController()
    const key = storedKey === HOST_KEY_PRESENT ? "host-key" : storedKey
    void listElevenLabsVoices(key, controller.signal).then((voices) => {
      if (controller.signal.aborted) return
      setAccountVoices(voices)
      const matches = voices.filter((item) => item.name.toLowerCase() === voice.toLowerCase())
      if (matches.length === 1 && matches[0].id !== voice) {
        void save({ elevenlabsVoice: matches[0].id })
      }
    })
    return () => controller.abort()
  }, [storedKey, voice, save])

  const voiceOptions = accountVoices.length > 0 ? accountVoices : ELEVENLABS_TTS_VOICES
  const hasSelectedVoice = voiceOptions.some((item) => item.id === voice)

  return (
    <div className="space-y-3">
      <ApiKeyInput
        provider="elevenlabs"
        label={t("label.elevenlabs")}
        placeholder={t("apiKeyPlaceholder.elevenlabs")}
      />
      <div className="space-y-2">
        <Label className="text-xs">{t("voice")}</Label>
        <TtsVoiceSelector
          value={voice}
          options={hasSelectedVoice ? voiceOptions : [{ id: voice, name: voice }, ...voiceOptions]}
          onValueChange={(v) => void save({ elevenlabsVoice: v })}
          getVoiceOverlay={(voiceId) => ({
            ttsProvider: "elevenlabs",
            elevenlabsVoice: voiceId,
          })}
        />
        <Input
          value={voice}
          onChange={(event) => void save({ elevenlabsVoice: event.target.value })}
          placeholder={t("elevenVoiceIdPlaceholder")}
          spellCheck={false}
        />
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
        <TtsVoiceSelector
          value={voice}
          options={LMNT_TTS_VOICES}
          onValueChange={(v) => void save({ lmntVoice: v })}
          getVoiceOverlay={(voiceId) => ({
            ttsProvider: "lmnt",
            lmntVoice: voiceId as (typeof LMNT_TTS_VOICES)[number]["id"],
          })}
        />
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
        <TtsVoiceSelector
          value={voice}
          options={HUME_TTS_VOICES}
          onValueChange={(v) => void save({ humeVoice: v })}
          getVoiceOverlay={(voiceId) => ({
            ttsProvider: "hume",
            humeVoice: voiceId as (typeof HUME_TTS_VOICES)[number]["id"],
          })}
        />
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
        <TtsVoiceSelector
          value={voice}
          options={CARTESIA_TTS_VOICES}
          onValueChange={(v) => void save({ cartesiaVoice: v })}
          getVoiceOverlay={(voiceId) => ({
            ttsProvider: "cartesia",
            cartesiaVoice: voiceId as (typeof CARTESIA_TTS_VOICES)[number]["id"],
          })}
        />
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
        <TtsVoiceSelector
          value={voice}
          options={DEEPGRAM_TTS_VOICES}
          onValueChange={(v) => void save({ deepgramVoice: v })}
          getVoiceOverlay={(voiceId) => ({
            ttsProvider: "deepgram",
            deepgramVoice: voiceId as (typeof DEEPGRAM_TTS_VOICES)[number]["id"],
          })}
        />
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
      <ApiKeyInput
        provider="xiaomi"
        label={t("label.xiaomi")}
        placeholder={t("apiKeyPlaceholder.generic")}
      />
      <div className="space-y-2">
        <Label className="text-xs">{t("voice")}</Label>
        <TtsVoiceSelector
          value={voice}
          options={XIAOMI_TTS_VOICES}
          onValueChange={(v) => void save({ xiaomiVoice: v })}
          getVoiceOverlay={(voiceId) => ({
            ttsProvider: "xiaomi",
            xiaomiVoice: voiceId as (typeof XIAOMI_TTS_VOICES)[number]["id"],
          })}
        />
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

// -- OpenAI Realtime ---------------------------------------------------------

export function OpenAiRealtimeConfig() {
  const t = useTranslations("settings.speech.provider")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const voice = settings?.realtimeVoice ?? "marin"
  const model = settings?.realtimeModel ?? "gpt-realtime-2.1"
  const instructions = settings?.realtimeInstructions ?? ""

  return (
    <div className="space-y-3">
      {!isTauri() && (
        <p className="text-xs text-amber-600 dark:text-amber-500">{t("realtimeDesktopOnly")}</p>
      )}
      <p className="text-xs text-muted-foreground">{t("realtimeIntro")}</p>
      <ApiKeyInput
        provider="openai"
        label={t("label.openai")}
        placeholder={t("apiKeyPlaceholder.generic")}
      />
      <div className="space-y-2">
        <Label className="text-xs">{t("voice")}</Label>
        <TtsVoiceSelector
          value={voice}
          options={REALTIME_TTS_VOICES}
          onValueChange={(v) => void save({ realtimeVoice: v })}
          getVoiceOverlay={(voiceId) => ({
            ttsProvider: "openai-realtime",
            realtimeVoice: voiceId as (typeof REALTIME_TTS_VOICES)[number]["id"],
          })}
        />
      </div>
      <div className="space-y-2">
        <Label className="text-xs">{t("model")}</Label>
        <Select value={model} onValueChange={(v) => void save({ realtimeModel: v })}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REALTIME_TTS_MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name} — {m.description}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label className="text-xs">{t("voiceInstructions")}</Label>
        <Textarea
          value={instructions}
          onChange={(e) => void save({ realtimeInstructions: e.target.value })}
          placeholder={t("voiceInstructionsPlaceholder")}
          rows={3}
        />
      </div>
    </div>
  )
}

// -- Mapping -----------------------------------------------------------------

import type { TTSProvider } from "@cognia/tts/types"

export const PROVIDER_CONFIG_COMPONENTS: Record<TTSProvider, () => React.ReactElement> = {
  system: SystemConfig,
  openai: OpenAiConfig,
  "local-openai-compatible": LocalOpenAiCompatibleConfig,
  "openai-realtime": OpenAiRealtimeConfig,
  gemini: GeminiConfig,
  edge: EdgeConfig,
  elevenlabs: ElevenLabsConfig,
  lmnt: LmntConfig,
  hume: HumeConfig,
  cartesia: CartesiaConfig,
  deepgram: DeepgramConfig,
  xiaomi: XiaomiConfig,
  mistral: MistralConfig,
}
