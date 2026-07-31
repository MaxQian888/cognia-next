/**
 * Plugin Tool-Result Renderer Registry.
 *
 * Holds the live map from a normalized tool name → plugin-supplied React card
 * that renders that tool's result inside a chat message.
 *
 * Why this exists separately from `message-part-renderers.ts`: a tool call is
 * NOT a custom part type. It arrives as `tool-<name>` / `dynamic-tool`, both of
 * which the host claims (`message-part-api.ts` reserves the `tool-` prefix, and
 * `message-renderer.tsx` routes every tool part to its own renderer before the
 * plugin part registry is consulted). So a plugin that ships an MCP tool had no
 * way to render its own result richly — it always fell through to
 * `McpContentBlocksCard` / `ToolBody`. This registry is the missing seam, and
 * `mcp-tool-card.tsx` consults it when the host's built-in card table misses.
 *
 * Keys are folded through `bareToolName`, so a plugin registers the bare tool
 * name once (`computer_use`) and the card resolves on every provider path —
 * the ai-sdk route delivers it flat while the Anthropic escape hatch namespaces
 * it `mcp__cognia-plugin-tools__computer_use`.
 *
 * Pattern (subscribe / revision / clear-per-plugin) mirrors
 * `lib/plugin/api/message-part-renderers.ts` so the two surfaces feel the same
 * and both can drive a `useSyncExternalStore` in the renderer.
 */

import type React from "react"
import type { DynamicToolUIPart, ToolUIPart } from "ai"

import { bareToolName } from "@/lib/chat/tool-summary"

export interface ToolResultRendererProps {
  /** The tool part, exactly as it sits in `UIMessage.parts[i]`. */
  part: ToolUIPart | DynamicToolUIPart
  /** Chat session this tool call belongs to, when the host knows it. */
  sessionId?: string
}

export interface ToolResultRendererEntry {
  pluginId: string
  /** The normalized (bare) tool name this renderer claims. */
  toolName: string
  component: React.ComponentType<ToolResultRendererProps>
}

const registry = new Map<string, ToolResultRendererEntry>()
const listeners = new Set<() => void>()
let revision = 0

function notify(): void {
  revision += 1
  for (const l of listeners) l()
}

/** Fold a raw tool name / part type onto its registry key. */
export function toolResultRendererKey(toolName: string): string {
  return bareToolName(toolName)
}

/**
 * Register a renderer for `toolName`. The latest registration wins; the prior
 * entry is restored on unregister when it belonged to a different plugin, so a
 * hot-reload doesn't silently drop another plugin's card.
 */
export function registerToolResultRenderer(
  pluginId: string,
  toolName: string,
  component: React.ComponentType<ToolResultRendererProps>
): () => void {
  const key = toolResultRendererKey(toolName)
  const prior = registry.get(key)
  registry.set(key, { pluginId, toolName: key, component })
  notify()
  return () => {
    const current = registry.get(key)
    if (current && current.component === component && current.pluginId === pluginId) {
      if (prior && prior.pluginId !== pluginId) {
        registry.set(key, prior)
      } else {
        registry.delete(key)
      }
      notify()
    }
  }
}

/** Look up a renderer by raw or normalized tool name. `undefined` when none. */
export function getToolResultRenderer(toolName: string): ToolResultRendererEntry | undefined {
  return registry.get(toolResultRendererKey(toolName))
}

/** Drop every registration owned by `pluginId`. */
export function clearToolResultRenderersForPlugin(pluginId: string): void {
  let mutated = false
  for (const [key, entry] of registry) {
    if (entry.pluginId === pluginId) {
      registry.delete(key)
      mutated = true
    }
  }
  if (mutated) notify()
}

/** Clear every renderer. Used by tests. */
export function clearAllToolResultRenderers(): void {
  if (registry.size === 0) return
  registry.clear()
  notify()
}

/** Snapshot of the registry for inspection (sorted by tool name). */
export function listToolResultRenderers(): ToolResultRendererEntry[] {
  return [...registry.values()].sort((a, b) => a.toolName.localeCompare(b.toolName))
}

/** Subscribe to registry mutations. Returns an unsubscribe. */
export function subscribeToolResultRenderers(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Monotonic counter bumped on every mutation — for `useSyncExternalStore`. */
export function getToolResultRenderersRevision(): number {
  return revision
}
