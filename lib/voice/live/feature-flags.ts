/**
 * Per-provider kill switches for the live-voice rollout.
 *
 * Precedence mirrors `lib/ai/agent/execution/feature-flags.ts`: defaults <
 * `NEXT_PUBLIC_*` env < localStorage. When `window` is absent (node tests,
 * headless hosts) only env applies, so one module serves every host.
 *
 * **Defaults deviate from the original plan's "all off".** That was written
 * when nothing had shipped. A flag whose default is off is a feature gate; a
 * flag whose default is on is a kill switch — and a kill switch is what the
 * rollout criteria actually call for ("connection success <95% for one provider
 * → turn its flag off, leaving the others alone"). So the three providers with
 * a working adapter default on, and the three without one default off.
 *
 * Nothing turns on by accident regardless: `AppSettings.liveVoice.enabled`
 * defaults to `false` and no deployments are configured out of the box, so
 * these flags only decide which providers a user *may* select.
 */

import { LIVE_VOICE_PROVIDER_IDS, type LiveVoiceProviderId } from "./types"

export type LiveVoiceFlag =
  | "liveVoiceOpenai"
  | "liveVoiceGoogle"
  | "liveVoiceXai"
  | "liveVoiceQwen"
  | "liveVoiceDoubao"
  | "liveVoiceBaidu"

const LIVE_VOICE_FLAGS_KEY = "cognia-live-voice-flags-v1"

/** Provider → its flag. Keyed by the provider union so a new provider fails to compile without one. */
export const LIVE_VOICE_PROVIDER_FLAGS: Readonly<Record<LiveVoiceProviderId, LiveVoiceFlag>> = {
  openai: "liveVoiceOpenai",
  google: "liveVoiceGoogle",
  xai: "liveVoiceXai",
  qwen: "liveVoiceQwen",
  doubao: "liveVoiceDoubao",
  baidu: "liveVoiceBaidu",
}

export const LIVE_VOICE_FLAGS: readonly LiveVoiceFlag[] = LIVE_VOICE_PROVIDER_IDS.map(
  (provider) => LIVE_VOICE_PROVIDER_FLAGS[provider]
)

const DEFAULT_LIVE_VOICE_FLAGS: Record<LiveVoiceFlag, boolean> = {
  // Shipped with an AI SDK adapter — on, and killable per provider.
  liveVoiceOpenai: true,
  liveVoiceGoogle: true,
  liveVoiceXai: true,
  // No adapter until the Phase 2 relay lands; selecting one would only throw.
  liveVoiceQwen: false,
  liveVoiceDoubao: false,
  liveVoiceBaidu: false,
}

function parseFlagValue(raw: string | undefined): boolean | undefined {
  if (raw === "1" || raw === "true") return true
  if (raw === "0" || raw === "false") return false
  return undefined
}

function readEnvFlags(): Partial<Record<LiveVoiceFlag, boolean>> {
  // Each env var is referenced statically so Next.js can inline it into the
  // client bundle; read per-call so node/headless env changes are observed.
  const raw: Record<LiveVoiceFlag, string | undefined> = {
    liveVoiceOpenai: process.env.NEXT_PUBLIC_LIVE_VOICE_OPENAI,
    liveVoiceGoogle: process.env.NEXT_PUBLIC_LIVE_VOICE_GOOGLE,
    liveVoiceXai: process.env.NEXT_PUBLIC_LIVE_VOICE_XAI,
    liveVoiceQwen: process.env.NEXT_PUBLIC_LIVE_VOICE_QWEN,
    liveVoiceDoubao: process.env.NEXT_PUBLIC_LIVE_VOICE_DOUBAO,
    liveVoiceBaidu: process.env.NEXT_PUBLIC_LIVE_VOICE_BAIDU,
  }
  const result: Partial<Record<LiveVoiceFlag, boolean>> = {}
  for (const flag of LIVE_VOICE_FLAGS) {
    const parsed = parseFlagValue(raw[flag])
    if (parsed !== undefined) result[flag] = parsed
  }
  return result
}

function readStoredFlags(): Partial<Record<LiveVoiceFlag, boolean>> {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(LIVE_VOICE_FLAGS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<Record<LiveVoiceFlag, unknown>>
    const result: Partial<Record<LiveVoiceFlag, boolean>> = {}
    for (const flag of LIVE_VOICE_FLAGS) {
      if (typeof parsed[flag] === "boolean") result[flag] = parsed[flag]
    }
    return result
  } catch {
    return {}
  }
}

export function getLiveVoiceFlags(): Record<LiveVoiceFlag, boolean> {
  return { ...DEFAULT_LIVE_VOICE_FLAGS, ...readEnvFlags(), ...readStoredFlags() }
}

export function isLiveVoiceFlagEnabled(flag: LiveVoiceFlag): boolean {
  return getLiveVoiceFlags()[flag]
}

/** Whether `provider` is currently permitted by its kill switch. */
export function isLiveVoiceProviderEnabled(provider: LiveVoiceProviderId): boolean {
  return isLiveVoiceFlagEnabled(LIVE_VOICE_PROVIDER_FLAGS[provider])
}

/**
 * Persist an override for one flag into the localStorage layer.
 *
 * Writes the FULL resolved override map rather than a single key, so a flag the
 * env had flipped stays flipped after an unrelated toggle. No-ops without
 * `window`, where env is the only layer.
 */
export function setLiveVoiceFlag(flag: LiveVoiceFlag, value: boolean): void {
  if (typeof window === "undefined") return
  const next = { ...readStoredFlags(), [flag]: value }
  try {
    window.localStorage.setItem(LIVE_VOICE_FLAGS_KEY, JSON.stringify(next))
  } catch {
    // Private mode / quota exceeded: subscribers re-read through
    // getLiveVoiceFlags(), so a failed write shows as the toggle snapping back
    // rather than a lie about the flag being on.
  }
  for (const listener of listeners) listener()
}

const listeners = new Set<() => void>()

/**
 * Subscribe to changes made through {@link setLiveVoiceFlag}.
 *
 * Only same-tab writes notify. A `storage` listener would also pick up other
 * tabs, but these flags decide which provider a live session dials, and
 * adopting another tab's edit mid-conversation is worse than being stale.
 */
export function subscribeToLiveVoiceFlags(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
