/**
 * Built-in completion provider registration + context assembly.
 *
 * Registers the two host providers (history + AI) into the shared registry
 * exactly once. Both are gated by the `terminal.autocomplete.source`
 * setting (read lazily via the injected `getSettings` so changes apply
 * live). Plugin-contributed providers register separately via the
 * terminal-completion bridge and are unaffected by `source`.
 *
 * `buildAutocompleteContext` turns a terminal store row + the locally
 * tracked input into the `TerminalCompletionContext` the providers consume.
 */

import { detectShellKind, type ShellPlatform } from "@/lib/terminal/shell-detect"
import type { LlmClient } from "@/lib/twin/distill/llm"
import {
  __resetAiCompletionCacheForTesting,
  AI_PROVIDER_ID,
  createAiCompletionProvider,
} from "./ai-provider"
import { historyProvider } from "./history-provider"
import { registerCompletionProvider } from "./registry"
import type { TerminalCompletionContext, TerminalCompletionProvider } from "./types"

export interface BuiltinCompletionSettings {
  source?: "history" | "ai" | "both"
}

export interface BuiltinCompletionDeps {
  /** Read the current autocomplete settings (lazy — called per query). */
  getSettings: () => BuiltinCompletionSettings | null | undefined
  /** Build the LlmClient for the AI provider, or null when unavailable. */
  buildClient: () => LlmClient | null
}

let registered = false
let disposers: Array<() => void> = []

/** Assemble the provider context from a store row + the tracked input. */
export function buildAutocompleteContext(args: {
  sessionId: string
  shellPath: string
  cwd: string | null
  recentCommands: string[]
  input: string
  platform: ShellPlatform
}): TerminalCompletionContext {
  return {
    sessionId: args.sessionId,
    shell: detectShellKind(args.shellPath),
    shellPath: args.shellPath,
    cwd: args.cwd,
    input: args.input,
    cursor: args.input.length,
    recentCommands: args.recentCommands,
    platform: args.platform,
  }
}

/** Register the built-in history + AI providers once (idempotent). */
export function ensureBuiltinCompletionProviders(deps: BuiltinCompletionDeps): void {
  if (registered) return
  registered = true

  const sourceOf = () => deps.getSettings()?.source ?? "both"

  const history: TerminalCompletionProvider = {
    id: historyProvider.id,
    label: historyProvider.label,
    priority: historyProvider.priority,
    getCompletions: async (context, signal) => {
      if (sourceOf() === "ai") return []
      return historyProvider.getCompletions(context, signal)
    },
  }

  const ai = createAiCompletionProvider({
    getClient: () => {
      if (sourceOf() === "history") return null
      return deps.buildClient()
    },
  })

  disposers.push(registerCompletionProvider(history))
  disposers.push(registerCompletionProvider(ai))
}

/** Whether the AI provider is currently registered (for diagnostics). */
export function isAiProviderRegistered(): boolean {
  return registered
}

export { AI_PROVIDER_ID }

/** Test-only: unregister the built-ins and clear the AI cache. */
export function __resetBuiltinCompletionProvidersForTesting(): void {
  for (const d of disposers) d()
  disposers = []
  registered = false
  __resetAiCompletionCacheForTesting()
}
