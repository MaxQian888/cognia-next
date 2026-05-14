/**
 * Plugin Message Part Renderer Registry.
 *
 * Holds the live map from `part.type` → plugin-supplied React component.
 * Kept separate from the per-plugin `createMessagePartAPI` factory so the
 * registry has a single module identity and tests can introspect / reset it
 * without going through the plugin layer.
 *
 * Pattern mirrors `lib/artifacts/renderer-registry.ts` (used by
 * `registerArtifactRenderer`) so the two extension surfaces feel the same.
 */

import type React from "react"
import type { UIMessage } from "ai"

export interface MessagePartRendererProps {
  /** The part that triggered the renderer — exactly the value from `UIMessage.parts[i]`. */
  part: UIMessage["parts"][number]
  /** Id of the message this part belongs to. Plugins can use it for keying. */
  messageId?: string
  /** True while this is the most recent assistant message and we're still streaming. */
  isStreaming?: boolean
}

export interface MessagePartRendererEntry {
  pluginId: string
  type: string
  component: React.ComponentType<MessagePartRendererProps>
}

const registry = new Map<string, MessagePartRendererEntry>()
const listeners = new Set<() => void>()
let revision = 0

function notify(): void {
  revision += 1
  for (const l of listeners) l()
}

/**
 * Register a renderer for `type`. The latest registration for a given type
 * wins; the previous entry is returned to the unregister callback so it can
 * be restored on hot-reload. Caller-side cleanup is preferred via the
 * returned `unregister`.
 */
export function registerMessagePartRenderer(
  pluginId: string,
  type: string,
  component: React.ComponentType<MessagePartRendererProps>
): () => void {
  const prior = registry.get(type)
  registry.set(type, { pluginId, type, component })
  notify()
  return () => {
    const current = registry.get(type)
    if (current && current.component === component && current.pluginId === pluginId) {
      if (prior && prior.pluginId !== pluginId) {
        registry.set(type, prior)
      } else {
        registry.delete(type)
      }
      notify()
    }
  }
}

/** Look up a renderer by part type. Returns `undefined` when none registered. */
export function getMessagePartRenderer(type: string): MessagePartRendererEntry | undefined {
  return registry.get(type)
}

/** Drop every registration owned by `pluginId`. */
export function clearMessagePartRenderersForPlugin(pluginId: string): void {
  let mutated = false
  for (const [type, entry] of registry) {
    if (entry.pluginId === pluginId) {
      registry.delete(type)
      mutated = true
    }
  }
  if (mutated) notify()
}

/** Clear every renderer. Used by tests. */
export function clearAllMessagePartRenderers(): void {
  if (registry.size === 0) return
  registry.clear()
  notify()
}

/** Snapshot of the registry for inspection (sorted by type). */
export function listMessagePartRenderers(): MessagePartRendererEntry[] {
  return [...registry.values()].sort((a, b) => a.type.localeCompare(b.type))
}

/** Subscribe to registry mutations. Returns an unsubscribe. */
export function subscribeMessagePartRenderers(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Monotonic counter bumped on every mutation — for `useSyncExternalStore`. */
export function getMessagePartRenderersRevision(): number {
  return revision
}
