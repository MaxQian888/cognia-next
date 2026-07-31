"use client"

// Sandboxed host for a plugin webview (B3). Renders the resolved `srcDoc` in an
// `<iframe sandbox="allow-scripts">` — crucially WITHOUT `allow-same-origin`,
// so the frame runs at an opaque origin with no access to the host window;
// it can only talk to the host via postMessage. Inbound messages are filtered
// by `event.source === iframe.contentWindow` so a sibling frame can't spoof.
//
// The host installs a "poster" on the registry so the plugin can push messages
// into the iframe (plugin → iframe), and forwards iframe → plugin messages
// (from `acquireCogniaWebviewApi().postMessage`) to the registry listeners.

import { useEffect, useRef } from "react"
import {
  attachWebviewPoster,
  dispatchWebviewMessage,
  getWebviewState,
  setWebviewState,
} from "@/lib/plugin/registries/webview-registry"

interface Props {
  /** Namespaced webview id (`<pluginId>:<viewId>`). */
  fullId: string
  /** Full wrapped document (CSP + polyfill) from the bridge. */
  srcDoc: string
  title?: string
  /**
   * Hands out a poster scoped to THIS iframe instance. The registry poster
   * fans out to every live frame of the same webview (desktop dock + mobile
   * sheet can both be mounted); per-instance state like panel visibility must
   * not leak to the sibling frame, so it goes through this channel instead.
   */
  onFrameReady?: (post: (data: unknown) => boolean) => void
}

export function PluginWebviewHost({ fullId, srcDoc, title, onFrameReady }: Props) {
  const ref = useRef<HTMLIFrameElement | null>(null)

  useEffect(() => {
    const iframe = ref.current
    if (!iframe) return

    const postToFrame = (data: unknown) => {
      const win = iframe.contentWindow
      if (!win) return false
      win.postMessage({ __cogniaWebview: "host", data }, "*")
      return true
    }

    // plugin → iframe: install a poster the registry can call.
    const detachPoster = attachWebviewPoster(fullId, postToFrame)
    onFrameReady?.(postToFrame)

    // iframe → plugin: forward only messages from THIS iframe's window.
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return
      const payload = event.data as {
        __cogniaWebview?: string
        data?: unknown
        state?: unknown
      } | null
      if (!payload) return
      if (payload.__cogniaWebview === "post") {
        dispatchWebviewMessage(fullId, { data: payload.data })
        return
      }
      // The frame is destroyed whenever its panel unmounts, so `setState` must
      // land host-side to mean anything — this used to be silently dropped.
      if (payload.__cogniaWebview === "set-state") {
        setWebviewState(fullId, payload.state)
      }
    }
    window.addEventListener("message", onMessage)

    // Seed a fresh frame with the last state a previous frame saved. On the
    // load event: the injected head script (whose listener receives this) has
    // run by then, while posting from this effect could race document parsing.
    const onLoad = () => {
      const state = getWebviewState(fullId)
      if (state === undefined) return
      iframe.contentWindow?.postMessage({ __cogniaWebview: "restore-state", state }, "*")
    }
    iframe.addEventListener("load", onLoad)

    return () => {
      detachPoster()
      window.removeEventListener("message", onMessage)
      iframe.removeEventListener("load", onLoad)
    }
  }, [fullId, onFrameReady])

  return (
    <iframe
      ref={ref}
      title={title ?? fullId}
      // SECURITY: allow-scripts WITHOUT allow-same-origin → opaque origin.
      sandbox="allow-scripts"
      srcDoc={srcDoc}
      className="h-full w-full border-0"
      data-plugin-webview={fullId}
    />
  )
}
