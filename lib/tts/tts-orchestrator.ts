/**
 * App binding for `@cognia/tts/tts-orchestrator` (ADR-0068 E3): keeps the
 * historical `@/lib/tts/tts-orchestrator` specifier stable and guarantees the
 * host bridges (Tauri proxy fetch, native-shell gate, sonner toasts) are
 * installed before the orchestrator synthesizes anything.
 *
 * It also METERS synthesis. Cloud TTS is billed per character and reported
 * nothing: reading a long answer aloud cost real money and left the Usage tab
 * unchanged. The metering lives here rather than in `@cognia/tts` so the
 * package stays free of the app's Dexie layer, and it wraps the singleton with
 * a Proxy so every existing `ttsOrchestrator.*` call site — state, subscribe,
 * stop, pause — keeps working untouched.
 */

import "./host-bindings"

import {
  ttsOrchestrator as coreOrchestrator,
  type TTSOrchestrator,
} from "@cognia/tts/tts-orchestrator"
import type { TTSProvider } from "@cognia/tts/types"

import { recordSurfaceUsage, swallowUsageWrite } from "@/lib/db/session-usage"

export * from "@cognia/tts/tts-orchestrator"

/**
 * Providers that synthesize on-device and bill nothing. Metering them would
 * report spend that never happened — worse than reporting none.
 */
const FREE_TTS_PROVIDERS: ReadonlySet<TTSProvider> = new Set<TTSProvider>(["system"])

let utteranceCounter = 0

function meterUtterance(characters: number, provider: TTSProvider | null | undefined): void {
  if (characters <= 0) return
  if (!provider || FREE_TTS_PROVIDERS.has(provider)) return
  utteranceCounter += 1
  swallowUsageWrite(
    recordSurfaceUsage({
      surface: "tts",
      // Every utterance is its own billable event — the same sentence read
      // twice is charged twice, so the id must not collapse them.
      operationId: `${provider}:${Date.now()}:${utteranceCounter}`,
      scopeId: provider,
      usage: {
        providerId: provider,
        unitBreakdown: { characters },
        // Per-character rates live in the pricing catalog; this layer records
        // the quantity and lets the one pricing authority decide the cost.
        costSource: "unknown",
        costKnown: false,
      },
    })
  )
}

/** Pass a token stream through untouched while tallying its characters. */
async function* countingTokens(
  tokens: AsyncIterable<string>,
  counter: { characters: number }
): AsyncIterable<string> {
  for await (const token of tokens) {
    counter.characters += token.length
    yield token
  }
}

/**
 * The metered singleton. Identical surface to the core orchestrator; only
 * `speak` and `speakStream` are intercepted, and both delegate first so a
 * metering failure can never change what the user hears.
 */
export const ttsOrchestrator: TTSOrchestrator = new Proxy(coreOrchestrator, {
  get(target, property, receiver) {
    if (property === "speak") {
      return async (text: string, options?: Parameters<TTSOrchestrator["speak"]>[1]) => {
        const result = await target.speak(text, options)
        // Read the provider the orchestrator actually RESOLVED, not the one
        // that was requested: the mobile shell forces `system`, and billing the
        // requested cloud provider there would be pure fiction.
        meterUtterance(text.length, target.getState().currentProvider)
        return result
      }
    }
    if (property === "speakStream") {
      return async (
        tokens: Parameters<TTSOrchestrator["speakStream"]>[0],
        options?: Parameters<TTSOrchestrator["speakStream"]>[1]
      ) => {
        // The orchestrator consumes the token stream, so the character count
        // only exists while it is being pulled — counting afterwards is not
        // possible. Tapping it also means an aborted stream bills only what it
        // actually synthesized.
        const counter = { characters: 0 }
        const result = await target.speakStream(countingTokens(tokens, counter), options)
        meterUtterance(counter.characters, target.getState().currentProvider)
        return result
      }
    }
    const value = Reflect.get(target, property, receiver)
    return typeof value === "function" ? value.bind(target) : value
  },
})
