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
import type { PluginProtocolAdapterDef } from "@/types/plugin/plugin-protocol-adapter"

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

/** Test-only: drop every registered adapter. */
export function __resetProtocolAdaptersForTesting(): void {
  overlay.__resetForTesting()
}
