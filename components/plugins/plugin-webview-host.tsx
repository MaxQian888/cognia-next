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
} from "@/lib/plugin/registries/webview-registry"

interface Props {
  /** Namespaced webview id (`<pluginId>:<viewId>`). */
  fullId: string
  /** Full wrapped document (CSP + polyfill) from the bridge. */
  srcDoc: string
  title?: string
}

export function PluginWebviewHost({ fullId, srcDoc, title }: Props) {
  const ref = useRef<HTMLIFrameElement | null>(null)

  useEffect(() => {
    const iframe = ref.current
    if (!iframe) return

    // plugin → iframe: install a poster the registry can call.
    const detachPoster = attachWebviewPoster(fullId, (data) => {
      const win = iframe.contentWindow
      if (!win) return false
      win.postMessage({ __cogniaWebview: "host", data }, "*")
      return true
    })

    // iframe → plugin: forward only messages from THIS iframe's window.
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return
      const payload = event.data as { __cogniaWebview?: string; data?: unknown } | null
      if (!payload || payload.__cogniaWebview !== "post") return
      dispatchWebviewMessage(fullId, { data: payload.data })
    }
    window.addEventListener("message", onMessage)

    return () => {
      detachPoster()
      window.removeEventListener("message", onMessage)
    }
  }, [fullId])

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
