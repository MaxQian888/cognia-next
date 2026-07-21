/**
 * Built-in completion provider registration + context assembly.
 *
 * Registers the host providers (history, AI, path, exe, spec) into the
 * shared registry exactly once. Each is gated by its
 * `terminal.autocomplete` setting (read lazily via the injected
 * `getSettings` so changes apply live). Plugin-contributed providers
 * register separately via the terminal-completion bridge and are
 * unaffected by these settings.
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
import { createExeCompletionProvider, type ExeProviderDeps } from "./exe-provider"
import { historyProvider } from "./history-provider"
import { createPathCompletionProvider, type PathProviderDeps } from "./path-provider"
import { registerCompletionProvider } from "./registry"
import { specCompletionProvider } from "./spec-provider"
import type { TerminalCompletionContext, TerminalCompletionProvider } from "./types"

export interface BuiltinCompletionSettings {
  source?: "history" | "ai" | "both"
  path?: boolean
  exe?: boolean
  spec?: boolean
}

export interface BuiltinCompletionDeps {
  /** Read the current autocomplete settings (lazy — called per query). */
  getSettings: () => BuiltinCompletionSettings | null | undefined
  /** Build the LlmClient for the AI provider, or null when unavailable. */
  buildClient: () => LlmClient | null
  /** Test seams for the host-backed providers. */
  pathDeps?: PathProviderDeps
  exeDeps?: ExeProviderDeps
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
  projectId?: string | null
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
    projectId: args.projectId ?? null,
  }
}

/** Wrap a provider so it consults a lazy settings gate per query. */
function gated(
  provider: TerminalCompletionProvider,
  isEnabled: () => boolean
): TerminalCompletionProvider {
  return {
    id: provider.id,
    label: provider.label,
    priority: provider.priority,
    getCompletions: async (context, signal) => {
      if (!isEnabled()) return []
      return provider.getCompletions(context, signal)
    },
  }
}

/** Register the built-in providers once (idempotent). */
export function ensureBuiltinCompletionProviders(deps: BuiltinCompletionDeps): void {
  if (registered) return
  registered = true

  const settings = () => deps.getSettings()
  const sourceOf = () => settings()?.source ?? "both"

  const history = gated(historyProvider, () => sourceOf() !== "ai")

  const ai = createAiCompletionProvider({
    getClient: () => {
      if (sourceOf() === "history") return null
      return deps.buildClient()
    },
  })

  const path = gated(createPathCompletionProvider(deps.pathDeps), () => settings()?.path !== false)
  const exe = gated(createExeCompletionProvider(deps.exeDeps), () => settings()?.exe !== false)
  const spec = gated(specCompletionProvider, () => settings()?.spec !== false)

  disposers.push(registerCompletionProvider(history))
  disposers.push(registerCompletionProvider(ai))
  disposers.push(registerCompletionProvider(path))
  disposers.push(registerCompletionProvider(exe))
  disposers.push(registerCompletionProvider(spec))
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
