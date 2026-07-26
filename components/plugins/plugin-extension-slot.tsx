"use client"

// Generic UI slot renderer for the 27 implemented `CanonicalExtensionPoint`s
// declared in `lib/plugin/contracts/plugin-points.ts`. Host code drops one of
// these in the right region (chat.input.above, settings.plugins, etc.) and
// every plugin that registered a component for that point gets rendered in
// `priority` order. Each plugin is wrapped in its own ErrorBoundary so a
// throwing extension can't take down the host UI.

import {
  Component,
  useEffect,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react"
import {
  getExtensionsForPoint,
  getExtensionRevision,
  subscribeExtensionChanges,
} from "@/lib/plugin/api"
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
          <PluginExtensionBoundary
            key={ext.id}
            pluginId={ext.pluginId}
            extensionId={ext.id}
            minWidth={ext.options.minWidth}
            maxWidth={ext.options.maxWidth}
          >
            <Cmp
              pluginId={ext.pluginId}
              extensionId={ext.id}
              formFactor={formFactor}
              context={context}
            />
          </PluginExtensionBoundary>
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

/** Hoisted so the wrapper's style prop keeps a stable identity across renders. */
const DISPLAY_CONTENTS = { display: "contents" } as const

/**
 * Memoised by hint pair for the same reason `DISPLAY_CONTENTS` is hoisted: the
 * wrapper re-renders on every registry and context-key revision, and a fresh
 * style object each time would rewrite the inline `style` attribute for no
 * reason. Bounded by the number of distinct hint pairs actually registered.
 */
const widthHintStyles = new Map<string, CSSProperties>()

/**
 * Turn a plugin's width hints into a style for the boundary wrapper.
 *
 * The clamping is the whole point of the feature living here rather than in
 * plugin CSS: `min(<hint>, 100%)` resolves against the slot's content box, so
 * whatever number a plugin declares, the box it gets can never be wider than
 * the region the host gave it. A ceiling of `100%` is applied even when only a
 * floor was declared — the floor is what would otherwise push the box past the
 * slot edge under flex pressure.
 *
 * With no hints the wrapper stays `display: contents`, which is load-bearing:
 * the element exists only as the `@scope` root for the plugin's
 * `manifest.styles` sheet, and generating a box would make a contribution to a
 * flex toolbar lay out as a nested child instead of a direct one. Declaring a
 * hint is opting into that box, and nothing else in the slot changes.
 */
function widthHintStyle(minWidth?: number, maxWidth?: number): CSSProperties {
  if (minWidth === undefined && maxWidth === undefined) return DISPLAY_CONTENTS
  const key = `${minWidth ?? ""}|${maxWidth ?? ""}`
  const cached = widthHintStyles.get(key)
  if (cached) return cached
  const style: CSSProperties = {
    display: "block",
    minWidth: minWidth === undefined ? undefined : `min(${minWidth}px, 100%)`,
    maxWidth: maxWidth === undefined ? "100%" : `min(${maxWidth}px, 100%)`,
  }
  widthHintStyles.set(key, style)
  return style
}

interface BoundaryProps {
  pluginId: string
  extensionId: string
  /** Plugin-declared inline-size floor in px, already sanitised by `extension-api`. */
  minWidth?: number
  /** Plugin-declared inline-size ceiling in px, already sanitised by `extension-api`. */
  maxWidth?: number
  children: ReactNode
}

interface BoundaryState {
  hasError: boolean
}

export class PluginExtensionBoundary extends Component<BoundaryProps, BoundaryState> {
  constructor(props: BoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    // Plug into the analytics event stream rather than console.error so the
    // /plugins panel can surface the failure later. Importing analytics lazily
    // avoids pulling that module into every host page.
    void import("@/lib/plugin/utils/analytics").then((mod) => {
      mod.trackPluginEvent?.({
        pluginId: this.props.pluginId,
        eventType: "error",
        success: false,
        errorMessage,
        metadata: { extensionId: this.props.extensionId, scope: "extension.render_error" },
      })
    })
    // Also record a runtime diagnostic so the render failure shows up in the
    // plugin diagnostics panel + per-plugin badge alongside load/conflict/
    // dependency failures — not only in the analytics stream (C4).
    void import("@/lib/plugin/contracts/diagnostics-store").then((mod) => {
      mod.recordPluginPointDiagnostic(this.props.pluginId, {
        code: "plugin.silent-failure",
        severity: "error",
        pointKind: "ui-slot",
        pointId: this.props.extensionId,
        message: `Extension "${this.props.extensionId}" crashed while rendering and was removed from its slot: ${errorMessage}`,
        hint: "The rest of the UI is unaffected. Check the plugin's component for a runtime error.",
      })
    })
  }

  render() {
    if (this.state.hasError) return null
    // `data-plugin-root` is the bound for the plugin's `manifest.styles` sheet
    // (`lib/plugin/styles/plugin-stylesheet.ts` wraps it in `@scope`). It needs
    // a real element, but `display: contents` keeps that element from
    // generating a layout box — so a plugin contributing a button to a flex
    // toolbar still lays out as a direct child of that flex container. A
    // width-hinted extension trades that away for a sizeable box; see
    // `widthHintStyle`.
    return (
      <div
        data-plugin-root={this.props.pluginId}
        style={widthHintStyle(this.props.minWidth, this.props.maxWidth)}
      >
        {this.props.children}
      </div>
    )
  }
}
