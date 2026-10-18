/**
 * The VNC viewer (ADR-0234 Phase 2): noVNC over the Host's loopback bridge.
 *
 * The Host authenticated to the server already and presents security type
 * None, so noVNC never sees a password, and a `credentialsrequired` event
 * means something is wrong rather than a prompt to show. View mode sets
 * `viewOnly` so no input is sent, but the boundary is the server's own
 * view-only password the Host used. Clipboard sync is off: no `clipboard`
 * listener and no paste-to-server.
 *
 * noVNC touches `window` and the DOM, so it is loaded inside the effect, on
 * the client only, never at module evaluation.
 */

import { useEffect, useLayoutEffect, useRef } from "react"
import type { RemoteDesktopViewerProps } from "@cognia/plugin-sdk"
import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"

import { PLUGIN_ID } from "./ids"

type RfbModule = typeof import("@novnc/novnc/lib/rfb")

export interface VncViewerProps extends RemoteDesktopViewerProps {
  /** Test seam: resolves the noVNC module. */
  loadRfb?: () => Promise<RfbModule>
}

const loadNoVnc = (): Promise<RfbModule> => import("@novnc/novnc/lib/rfb")

export function VncViewer({
  url,
  mode,
  scaleToFit,
  onStatus,
  onError,
  className,
  loadRfb = loadNoVnc,
}: VncViewerProps) {
  const t = usePluginTranslations(PLUGIN_ID)
  const container = useRef<HTMLDivElement | null>(null)
  const rfbRef = useRef<InstanceType<RfbModule["default"]> | null>(null)
  // Callbacks change identity every render; the connection must not. The
  // initial scale is read once at connect; later changes go through the
  // effect below without reconnecting.
  const callbacks = useRef({ onStatus, onError })
  const scale = useRef(scaleToFit)
  useLayoutEffect(() => {
    callbacks.current = { onStatus, onError }
    scale.current = scaleToFit
  })

  useEffect(() => {
    const target = container.current
    if (!target) return
    let cancelled = false
    let rfb: InstanceType<RfbModule["default"]> | null = null
    callbacks.current.onStatus("connecting")
    loadRfb()
      .then(({ default: RFB }) => {
        if (cancelled) return
        rfb = new RFB(target, url, { shared: true, wsProtocols: ["binary"] })
        rfbRef.current = rfb
        rfb.viewOnly = mode === "view"
        rfb.scaleViewport = scale.current
        rfb.clipViewport = !scale.current
        rfb.resizeSession = false
        rfb.focusOnClick = true
        // Events after teardown belong to a session the page already left;
        // reporting them would end the session that replaced it.
        rfb.addEventListener("connect", () => {
          if (!cancelled) callbacks.current.onStatus("connected")
        })
        rfb.addEventListener("disconnect", (event) => {
          if (cancelled) return
          const clean = (event as CustomEvent<{ clean?: boolean }>).detail?.clean !== false
          if (!clean) callbacks.current.onError("remote_desktop_connection_lost")
          callbacks.current.onStatus("disconnected")
        })
        rfb.addEventListener("credentialsrequired", () => {
          if (cancelled) return
          // The Host presents None; a prompt here would ask the user to type
          // a password into the wrong place.
          callbacks.current.onError("remote_desktop_protocol_invalid")
          rfb?.disconnect()
        })
        rfb.addEventListener("securityfailure", () => {
          if (cancelled) return
          callbacks.current.onError("remote_desktop_auth_failed")
        })
      })
      .catch(() => {
        if (!cancelled) {
          callbacks.current.onError("remote_desktop_viewer_failed")
          callbacks.current.onStatus("disconnected")
        }
      })
    return () => {
      cancelled = true
      rfbRef.current = null
      rfb?.disconnect()
    }
    // A new URL is a new session; mode changes reopen a session, too.
  }, [url, mode, loadRfb])

  useEffect(() => {
    const rfb = rfbRef.current
    if (!rfb) return
    rfb.scaleViewport = scaleToFit
    rfb.clipViewport = !scaleToFit
  }, [scaleToFit])

  return (
    <div
      ref={container}
      role="application"
      aria-label={
        mode === "view" ? `${t("viewer.label")} · ${t("viewer.viewOnly")}` : t("viewer.label")
      }
      className={className}
      style={{ width: "100%", height: "100%", background: "#111" }}
      data-testid="vnc-viewer"
    />
  )
}
