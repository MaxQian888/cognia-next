"use client"

// Generic UI slot renderer for the 27 implemented `CanonicalExtensionPoint`s
// declared in `lib/plugin/contracts/plugin-points.ts`. Host code drops one of
// these in the right region (chat.input.above, settings.plugins, etc.) and
// every plugin that registered a component for that point gets rendered in
// `priority` order. Each plugin is wrapped in its own ErrorBoundary so a
// throwing extension can't take down the host UI.

import { useEffect, useSyncExternalStore, type ReactNode } from "react"
import { PluginSurface } from "@/components/plugins/plugin-surface"
import {
  getExtensionsForPoint,
  getExtensionRevision,
  subscribeExtensionChanges,
} from "@/lib/plugin/api/extension-api"
import {
  getContextKeyRevision,
  subscribeContextKeys,
} from "@/lib/plugin/context-keys/context-key-store"
import {
  getExtensionPointFormFactor,
  type CanonicalExtensionPoint,
  type PluginPointFormFactor,
} from "@/lib/plugin/contracts/plugin-points"

/** Hoisted so the slot wrapper's style prop keeps a stable identity. */
const INLINE_SIZE_CONTAINER = { containerType: "inline-size" } as const

interface Props {
  point: CanonicalExtensionPoint
  /** Optional className applied to the wrapper around all rendered extensions. */
  className?: string
  /** Cap the number of extensions rendered (e.g., toolbar slots take 3 + overflow). */
  limit?: number
  /** Fallback rendered when no extensions are registered for the point. */
  fallback?: ReactNode
  /**
   * Optional host-provided context bag merged into each extension's props
   * as `context`. Inbox slots use this to deliver `conversationKey`,
   * `adapterId`, `platform`, `draftId`, etc. — so plugin contributions can
   * react to the active conversation without re-deriving identifiers from
   * the URL or store. The shape is freeform; each slot's docs should
   * describe the keys it provides.
   */
  context?: Record<string, unknown>
}

export function PluginExtensionSlot({ point, className, limit, fallback, context }: Props) {
  // Re-render whenever the registry mutates. Snapshot is the revision number
  // (a primitive — stable identity), not the registration array, so React's
  // "snapshot should be cached" check passes.
  useSyncExternalStore(subscribeExtensionChanges, getExtensionRevision, () => 0)
  // Also re-render when context keys flip, so `when`-gated extensions
  // (ExtensionOptions.when) appear/disappear live as app state changes.
  useSyncExternalStore(subscribeContextKeys, getContextKeyRevision, () => 0)

  // Lazy activation: a plugin gated on `onView:<point>` activates the first
  // time a slot for that point mounts. Fire-and-forget — the manager dedups
  // in-flight activations, so re-mounts are harmless. The dynamic import keeps
  // the manager out of every host page's bundle and tolerates the web profile
  // / an uninitialized manager.
  useEffect(() => {
    let cancelled = false
    void import("@/lib/plugin/core/manager")
      .then(({ getPluginManager }) => {
        if (cancelled) return undefined
        return getPluginManager().handleActivationEvent(`onView:${point}`)
      })
      .catch(() => {
        // Plugin manager not initialized — nothing to activate.
      })
    return () => {
      cancelled = true
    }
  }, [point])

  const all = getExtensionsForPoint(point)
  const ordered = [...all].sort((a, b) => (b.options.priority ?? 0) - (a.options.priority ?? 0))
  const visible = typeof limit === "number" ? ordered.slice(0, limit) : ordered

  if (visible.length === 0) {
    return fallback ? <>{fallback}</> : null
  }

  const formFactor = getExtensionPointFormFactor(point)

  return (
    <div
      className={className}
      data-plugin-extension-slot={point}
      data-extension-count={visible.length}
      data-form-factor={formFactor}
      // Makes this wrapper a query container, so a plugin's scoped stylesheet
      // can respond to how wide its slot actually is (`@container (min-width:
      // …)`) without the host measuring anything per frame. `inline-size` only
      // — a `size` container would need a fixed block size and would collapse
      // slots whose height is driven by their content.
      style={INLINE_SIZE_CONTAINER}
    >
      {visible.map((ext) => {
        const Cmp = ext.component as unknown as React.ComponentType<{
          pluginId: string
          extensionId: string
          formFactor: PluginPointFormFactor
          context?: Record<string, unknown>
        }>
        return (
          <PluginSurface
            key={ext.id}
            pluginId={ext.pluginId}
            surfaceId={ext.id}
            formFactor={formFactor}
            minWidth={ext.options.minWidth}
            maxWidth={ext.options.maxWidth}
          >
            <Cmp
              pluginId={ext.pluginId}
              extensionId={ext.id}
              formFactor={formFactor}
              context={context}
            />
          </PluginSurface>
        )
      })}
    </div>
  )
}

/**
 * Reactive check for whether a UI extension point currently has at least one
 * visible (context-key gated) contribution. Hosts use this to decide whether
 * to render surrounding chrome (a toolbar row, a bordered panel) that would
 * otherwise show empty when only a plugin — and no native content — occupies
 * the surface. Subscribes to the same registry + context-key revisions as
 * `PluginExtensionSlot`, so it stays in sync as plugins enable/disable and as
 * `when`-gated extensions appear/disappear.
 */
export function usePluginSlotHasExtensions(point: CanonicalExtensionPoint): boolean {
  useSyncExternalStore(subscribeExtensionChanges, getExtensionRevision, () => 0)
  useSyncExternalStore(subscribeContextKeys, getContextKeyRevision, () => 0)
  return getExtensionsForPoint(point).length > 0
}
