"use client"

// Generic UI slot renderer for the 27 implemented `CanonicalExtensionPoint`s
// declared in `lib/plugin/contracts/plugin-points.ts`. Host code drops one of
// these in the right region (chat.input.above, settings.plugins, etc.) and
// every plugin that registered a component for that point gets rendered in
// `priority` order. Each plugin is wrapped in its own ErrorBoundary so a
// throwing extension can't take down the host UI.

import { Component, useSyncExternalStore, type ReactNode } from "react"
import {
  getExtensionsForPoint,
  getExtensionRevision,
  subscribeExtensionChanges,
} from "@/lib/plugin/api"
import type { CanonicalExtensionPoint } from "@/lib/plugin/contracts/plugin-points"

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

  const all = getExtensionsForPoint(point)
  const ordered = [...all].sort((a, b) => (b.options.priority ?? 0) - (a.options.priority ?? 0))
  const visible = typeof limit === "number" ? ordered.slice(0, limit) : ordered

  if (visible.length === 0) {
    return fallback ? <>{fallback}</> : null
  }

  return (
    <div
      className={className}
      data-plugin-extension-slot={point}
      data-extension-count={visible.length}
    >
      {visible.map((ext) => {
        const Cmp = ext.component as unknown as React.ComponentType<{
          pluginId: string
          extensionId: string
          context?: Record<string, unknown>
        }>
        return (
          <PluginExtensionBoundary key={ext.id} pluginId={ext.pluginId} extensionId={ext.id}>
            <Cmp pluginId={ext.pluginId} extensionId={ext.id} context={context} />
          </PluginExtensionBoundary>
        )
      })}
    </div>
  )
}

interface BoundaryProps {
  pluginId: string
  extensionId: string
  children: ReactNode
}

interface BoundaryState {
  hasError: boolean
}

class PluginExtensionBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    // Plug into the analytics event stream rather than console.error so the
    // /plugins panel can surface the failure later. Importing analytics lazily
    // avoids pulling that module into every host page.
    void import("@/lib/plugin/utils/analytics").then((mod) => {
      mod.trackPluginEvent?.({
        pluginId: this.props.pluginId,
        eventType: "error",
        success: false,
        errorMessage: error instanceof Error ? error.message : String(error),
        metadata: { extensionId: this.props.extensionId, scope: "extension.render_error" },
      })
    })
  }

  render() {
    if (this.state.hasError) return null
    return this.props.children
  }
}
