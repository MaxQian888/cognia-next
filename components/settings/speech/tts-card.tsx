"use client"

import { Volume2Icon } from "lucide-react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { useSettingsStore } from "@/stores/settings-store"
import { ORDERED_TTS_PROVIDERS, TTS_PROVIDERS, type TTSProvider } from "@/lib/tts/types"
import { TestTtsButton } from "./test-tts-button"
import { PROVIDER_CONFIG_COMPONENTS } from "./provider-config"

/**
 * Text-to-speech card. Shows the master toggle, provider switch, the
 * provider-specific config sub-panel, then the global rate/pitch/volume
 * controls + auto-play / cache toggles.
 */
export function TtsCard() {
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const setTtsEnabled = useSettingsStore((s) => s.setTtsEnabled)
  const setTtsProvider = useSettingsStore((s) => s.setTtsProvider)
  const setTtsAutoPlay = useSettingsStore((s) => s.setTtsAutoPlay)
  const setTtsRate = useSettingsStore((s) => s.setTtsRate)
  const setTtsPitch = useSettingsStore((s) => s.setTtsPitch)
  const setTtsVolume = useSettingsStore((s) => s.setTtsVolume)

  const ttsEnabled = settings?.ttsEnabled ?? false
  const provider: TTSProvider = (settings?.ttsProvider ?? "system") as TTSProvider
  const ttsAutoPlay = settings?.ttsAutoPlay ?? false
  const ttsRate = settings?.ttsRate ?? 1.0
  const ttsPitch = settings?.ttsPitch ?? 1.0
  const ttsVolume = settings?.ttsVolume ?? 1.0
  const ttsCacheEnabled = settings?.ttsCacheEnabled ?? true
  const ttsStreamingEnabled = settings?.ttsStreamingEnabled ?? true

  const ProviderConfig = PROVIDER_CONFIG_COMPONENTS[provider]
  const info = TTS_PROVIDERS[provider]

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Volume2Icon className="size-4 text-muted-foreground" />
          Text-to-speech
        </CardTitle>
        <CardDescription className="text-xs">
          Configure read-aloud, auto-play of assistant responses, and your preferred provider.
          Provider API keys are stored in your OS keyring on the desktop app, or in IndexedDB on the
          web shell.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Master toggle */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label className="text-sm">Enable text-to-speech</Label>
            <p className="text-xs text-muted-foreground">
              When on, you can read assistant messages aloud and (optionally) auto-play them.
            </p>
          </div>
          <Switch checked={ttsEnabled} onCheckedChange={(v) => void setTtsEnabled(v)} />
        </div>

        {ttsEnabled && (
          <>
            <Separator />

            {/* Provider switch */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-sm">Provider</Label>
                <TestTtsButton />
              </div>
              <Select value={provider} onValueChange={(v) => void setTtsProvider(v as TTSProvider)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ORDERED_TTS_PROVIDERS.map((id) => (
                    <SelectItem key={id} value={id}>
                      {TTS_PROVIDERS[id].name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{info.description}</p>
            </div>

            <Separator />

            {/* Provider-specific config */}
            <div className="space-y-2">
              <ProviderConfig />
            </div>

            <Separator />

            {/* Global controls */}
            <div className="space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Rate</Label>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {ttsRate.toFixed(2)}x
                  </span>
                </div>
                <Slider
                  value={[ttsRate]}
                  min={0.5}
                  max={2.0}
                  step={0.05}
                  onValueChange={(v) => void setTtsRate(v[0])}
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Pitch</Label>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {ttsPitch.toFixed(2)}
                  </span>
                </div>
                <Slider
                  value={[ttsPitch]}
                  min={0}
                  max={2}
                  step={0.05}
                  onValueChange={(v) => void setTtsPitch(v[0])}
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Volume</Label>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {Math.round(ttsVolume * 100)}%
                  </span>
                </div>
                <Slider
                  value={[ttsVolume]}
                  min={0}
                  max={1}
                  step={0.05}
                  onValueChange={(v) => void setTtsVolume(v[0])}
                />
              </div>
            </div>

            <Separator />

            {/* Toggles */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-sm">Auto-play assistant responses</Label>
                  <p className="text-xs text-muted-foreground">
                    Speak each completed assistant message automatically.
                  </p>
                </div>
                <Switch checked={ttsAutoPlay} onCheckedChange={(v) => void setTtsAutoPlay(v)} />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-sm">Cache audio</Label>
                  <p className="text-xs text-muted-foreground">
                    Re-use generated audio for repeated playback. Cleared with the rest of your data
                    via Settings → Data.
                  </p>
                </div>
                <Switch
                  checked={ttsCacheEnabled}
                  onCheckedChange={(v) => void save({ ttsCacheEnabled: v })}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-sm">Enable streaming (when supported)</Label>
                  <p className="text-xs text-muted-foreground">
                    Some providers stream first-byte audio for lower latency.
                  </p>
                </div>
                <Switch
                  checked={ttsStreamingEnabled}
                  onCheckedChange={(v) => void save({ ttsStreamingEnabled: v })}
                />
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
