/**
 * Minimal hook resolving `pluginId → display metadata` (ADR-0030).
 *
 * Wraps the existing `usePluginStore` selector so the character-pack UI
 * (Settings row badge, mobile chip, picker group heading) doesn't need
 * to know about Zustand state shape. Returns `undefined` for both
 * "no plugin id provided" and "id not in the store yet" — the consumer
 * decides whether to render a placeholder or hide the affordance.
 *
 * The hook intentionally returns a stable shape (5 nullable fields)
 * rather than the raw Plugin row so future schema changes inside the
 * plugin store don't ripple into every consumer.
 */

import { usePluginStore } from "@/stores/plugin/plugin-store"

export interface PluginMetadata {
  id: string
  name: string
  icon?: string
  source?: string
  updateAvailable: boolean
}

export function usePluginMetadata(pluginId: string | undefined | null): PluginMetadata | undefined {
  const plugin = usePluginStore((s) => (pluginId ? s.plugins[pluginId] : undefined))
  if (!plugin || !pluginId) return undefined
  // `updateAvailable` is a manager-stamped marker on the manifest; see
  // `components/plugins/plugin-status-badge.tsx:PluginStatusPill` for the
  // canonical read pattern. Manifest is untyped here because the host
  // augments it post-install.
  const updateAvailable = Boolean(
    (plugin.manifest as { updateAvailable?: boolean }).updateAvailable
  )
  return {
    id: pluginId,
    name: plugin.manifest.name ?? pluginId,
    icon: plugin.manifest.icon,
    source: plugin.source,
    updateAvailable,
  }
}
