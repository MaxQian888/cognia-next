"use client"

// Renderer factory for webview-backed context panels: wraps PluginWebviewHost
// so a `contextPanels[].webview` manifest entry (or an RPC `register` naming a
// webview) renders that webview's sandboxed iframe as the panel body.
//
// The webview is resolved LAZILY from the registry on every render: the
// module-bridge map registers `context-panel` before `webview`, so at panel
// registration time the referenced webview may not exist yet. Until it shows
// up the panel renders a pending placeholder.
//
// Visibility flows through the per-instance frame poster (`onFrameReady`), not
// the registry's fan-out poster — the desktop dock and the force-mounted
// mobile sheet can host two live iframes of the same webview, and each must
// only hear about its own `active` state. The frame re-requests state with a
// "ready" marker once its listener is attached, so a push that raced the
// iframe boot is repaired.

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { PluginWebviewHost } from "@/components/plugins/plugin-webview-host"
import {
  contextPanelWebviewEvent,
  isContextPanelWebviewInbound,
} from "@/lib/plugin/bridge/context-panel-webview-protocol"
import {
  getWebview,
  onWebviewMessage,
  subscribeWebviews,
} from "@/lib/plugin/registries/webview-registry"
import type { ContextPanelRenderProps } from "@/types/context-workbench"
import type { PluginContextPanelRenderer } from "@/types/plugin/plugin-context-panel"

interface WebviewPanelProps extends ContextPanelRenderProps {
  fullId: string
  title?: string
}

function WebviewContextPanel({ fullId, title, active }: WebviewPanelProps) {
  const t = useTranslations("contextWorkbench")
  const webview = useSyncExternalStore(
    subscribeWebviews,
    () => getWebview(fullId),
    () => getWebview(fullId)
  )
  const framePostRef = useRef<((data: unknown) => boolean) | null>(null)
  const activeRef = useRef(active)

  const pushVisibility = useCallback((visible: boolean) => {
    framePostRef.current?.(contextPanelWebviewEvent("visibility", { visible }))
  }, [])

  const handleFrameReady = useCallback(
    (post: (data: unknown) => boolean) => {
      framePostRef.current = post
      pushVisibility(activeRef.current)
    },
    [pushVisibility]
  )

  useEffect(() => {
    activeRef.current = active
    pushVisibility(active)
  }, [active, pushVisibility])

  // Stateful panels hide inside React `<Activity mode="hidden">`, which TEARS
  // EFFECTS DOWN (and revives them on show) while keeping the DOM — so the
  // `active`-dep effect above never observes `false`. This effect's lifecycle
  // is the real signal there: cleanup fires exactly when the panel leaves the
  // screen, while the iframe's window is still alive to hear it.
  useEffect(() => {
    return () => pushVisibility(false)
  }, [pushVisibility])

  // The frame's "ready" marker means its listener just attached — re-send the
  // current visibility in case the initial push raced the iframe boot.
  useEffect(() => {
    return onWebviewMessage(fullId, (message) => {
      if (isContextPanelWebviewInbound(message.data) && message.data.kind === "ready") {
        pushVisibility(activeRef.current)
      }
    })
  }, [fullId, pushVisibility])

  if (!webview) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
        {t("webviewPanelPending")}
      </div>
    )
  }

  return (
    <PluginWebviewHost
      fullId={fullId}
      srcDoc={webview.srcDoc}
      title={title ?? webview.title}
      onFrameReady={handleFrameReady}
    />
  )
}

/**
 * Build the panel renderer for a webview-backed context panel. `webviewId` is
 * the plugin-local id; the registry key is `<pluginId>:<webviewId>`.
 */
export function createContextPanelWebviewRenderer(
  pluginId: string,
  webviewId: string,
  title?: string
): PluginContextPanelRenderer {
  const fullId = `${pluginId}:${webviewId}`
  const Renderer = (props: ContextPanelRenderProps) => (
    <WebviewContextPanel {...props} fullId={fullId} title={title} />
  )
  Renderer.displayName = `ContextPanelWebview(${fullId})`
  return Renderer
}
