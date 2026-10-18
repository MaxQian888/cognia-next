"use client"

/**
 * A third-party provider's viewer (ADR-0234 §3): the plugin's own sandboxed
 * webview, fed over a transferred `MessagePort`. This document holds the
 * connection (a ticketed WebSocket or an attached `cognia.rfb` channel) and
 * relays bytes, so the opaque-origin page never sees a URL, a ticket or the
 * transport (`lib/remote-desktop/port-relay.ts`).
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react"

import {
  PluginWebviewHost,
  type WebviewFramePoster,
} from "@/components/plugins/plugin-webview-host"
import { startRemoteDesktopRelay } from "@/lib/remote-desktop/port-relay"
import type { RemoteDesktopViewerProps } from "@/lib/remote-desktop/provider-registry"
import { getWebviewSnapshot, subscribeWebviews } from "@/lib/plugin/registries/webview-registry"

export interface RemoteDesktopWebviewViewerProps extends RemoteDesktopViewerProps {
  pluginId: string
  viewId: string
  title: string
  /** Test seam for the relay. */
  startRelay?: typeof startRemoteDesktopRelay
}

export function RemoteDesktopWebviewViewer({
  pluginId,
  viewId,
  title,
  connection,
  mode,
  onStatus,
  onError,
  className,
  startRelay = startRemoteDesktopRelay,
}: RemoteDesktopWebviewViewerProps) {
  const webviews = useSyncExternalStore(subscribeWebviews, getWebviewSnapshot, getWebviewSnapshot)
  const webview = webviews.find((entry) => entry.pluginId === pluginId && entry.viewId === viewId)
  const [poster, setPoster] = useState<WebviewFramePoster | null>(null)
  const handleFrameReady = useCallback((post: WebviewFramePoster) => setPoster(() => post), [])

  useEffect(() => {
    if (!webview) onError("remote_desktop_viewer_invalid")
  }, [webview, onError])

  useEffect(() => {
    if (!poster) return
    // Reports after teardown belong to a session the page already left.
    let active = true
    const stop = startRelay({
      connection,
      mode,
      post: (data, transfer) => poster(data, transfer),
      onStatus: (status) => active && onStatus(status),
      onError: (code) => active && onError(code),
    })
    return () => {
      active = false
      stop()
    }
  }, [poster, connection, mode, onStatus, onError, startRelay])

  if (!webview) return null
  return (
    <div className={className} data-testid="remote-desktop-webview-viewer">
      <PluginWebviewHost
        fullId={`${pluginId}:${viewId}`}
        srcDoc={webview.srcDoc}
        title={title}
        onFrameReady={handleFrameReady}
      />
    </div>
  )
}
