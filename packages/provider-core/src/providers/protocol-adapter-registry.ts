/**
 * Renderer-side registry of plugin-contributed protocol adapters
 * (declarative `openai-compatible-variant` specs — see
 * `types/plugin/plugin-protocol-adapter.ts`). `build-options` consults it to
 * forward the spec to the sidecar; the custom-provider protocol picker lists
 * it alongside the built-ins.
 *
 * Built-in protocol ids (both the renderer's `gemini` naming and the
 * sidecar's `google`/`mistral`/`cohere` family names) are refused so a
 * plugin can never shadow a native execution path.
 */

import { createOverlayRegistry } from "@/lib/plugin/registries/createOverlayRegistry"
import type {
  CodeProtocolAdapterFactory,
  PluginProtocolAdapterDef,
} from "@/types/plugin/plugin-protocol-adapter"

/** Renderer built-ins ∪ sidecar family names — ids a plugin may not claim. */
const RESERVED_PROTOCOL_IDS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "gemini",
  "google",
  "mistral",
  "cohere",
])

const overlay = createOverlayRegistry<PluginProtocolAdapterDef>({
  name: "protocol-adapters",
  conflictPolicy: "first-wins-cross-plugin",
})

/** Resolve a registered plugin protocol adapter by its (namespaced) id. */
export function getProtocolAdapter(id: string): PluginProtocolAdapterDef | undefined {
  return overlay.get(id)
}

/**
 * Register a plugin protocol adapter. Reserved/built-in ids are rejected
 * (returns false) so native protocols stay authoritative.
 */
export function registerProtocolAdapter(
  def: PluginProtocolAdapterDef,
  opts?: { pluginId?: string }
): boolean {
  if (RESERVED_PROTOCOL_IDS.has(def.id)) {
    return false
  }
  overlay.register(def.id, def, opts)
  return true
}

export function unregisterProtocolAdapter(id: string): boolean {
  return overlay.unregisterById(id)
}

export function unregisterProtocolAdaptersByPlugin(pluginId: string): number {
  return overlay.unregisterByPlugin(pluginId)
}

/** Every registered plugin protocol adapter (for the protocol picker). */
export function listProtocolAdapters(): Array<{
  id: string
  label: string
  pluginId?: string
}> {
  return overlay.entries().map(({ id, entry, pluginId }) => ({
    id,
    label: entry.label ?? id,
    pluginId,
  }))
}

// ---- Code-adapter executors (P2-E) -----------------------------------------
//
// Code adapters run their real fetch/transform/stream logic in the RENDERER.
// The bridge dynamic-imports the plugin's factory on enable and registers it
// here under the namespaced adapter id; the `protocol_adapter_exec` IPC pump
// resolves it per turn. Kept separate from the `def` overlay so the picker /
// build-options surface (which only needs the spec) stays code-free.

const codeExecutors = new Map<string, { factory: CodeProtocolAdapterFactory; pluginId?: string }>()

export function registerCodeAdapterExecutor(
  adapterId: string,
  factory: CodeProtocolAdapterFactory,
  pluginId?: string
): void {
  codeExecutors.set(adapterId, { factory, pluginId })
}

export function getCodeAdapterExecutor(adapterId: string): CodeProtocolAdapterFactory | undefined {
  return codeExecutors.get(adapterId)?.factory
}

/** Drop a single code-adapter executor by its (namespaced) adapter id. */
export function unregisterCodeAdapterExecutor(adapterId: string): boolean {
  return codeExecutors.delete(adapterId)
}

export function unregisterCodeAdapterExecutorsByPlugin(pluginId: string): number {
  let n = 0
  for (const [id, entry] of codeExecutors) {
    if (entry.pluginId === pluginId) {
      codeExecutors.delete(id)
      n++
    }
  }
  return n
}

/** Test-only: drop every registered adapter. */
export function __resetProtocolAdaptersForTesting(): void {
  overlay.__resetForTesting()
  codeExecutors.clear()
}
