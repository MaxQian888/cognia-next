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
  type TTSOrchestratorState,
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
 * The metered singleton. The explicit facade keeps every method identity
 * stable (important for React subscriptions and test spies) while delegating
 * all state to the one package-owned orchestrator instance.
 */
type TestableTTSFacade = TTSOrchestrator & {
  setState(patch: Partial<TTSOrchestratorState>): void
}

const facade = {
  subscribe: coreOrchestrator.subscribe.bind(coreOrchestrator),
  getState: coreOrchestrator.getState.bind(coreOrchestrator),
  stop: coreOrchestrator.stop.bind(coreOrchestrator),
  pause: coreOrchestrator.pause.bind(coreOrchestrator),
  resume: coreOrchestrator.resume.bind(coreOrchestrator),
  setState: (
    coreOrchestrator as unknown as { setState(patch: Partial<TTSOrchestratorState>): void }
  ).setState.bind(coreOrchestrator),
  async speak(text, options) {
    const result = await coreOrchestrator.speak(text, options)
    meterUtterance(text.length, coreOrchestrator.getState().currentProvider)
    return result
  },
  async speakStream(tokens, options) {
    const counter = { characters: 0 }
    const result = await coreOrchestrator.speakStream(countingTokens(tokens, counter), options)
    meterUtterance(counter.characters, coreOrchestrator.getState().currentProvider)
    return result
  },
} as unknown as TestableTTSFacade

export const ttsOrchestrator: TTSOrchestrator = facade
