"use client"

/**
 * One VS Code extension webview, in a sandboxed frame.
 *
 * The frame's document is built from the webview's HTML whenever that changes
 * (`prepareWebviewFrame`), so it can run under the app's content security
 * policy; the frame then talks to the extension through `connectWebviewFrame`.
 * The sandbox grants scripts and forms only as the webview's options do, and
 * never `allow-same-origin`, so the frame cannot reach the app.
 *
 * The extension is told the webview is visible while it is the shown tab and
 * actually on screen, and the frame follows the app's theme.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"

import { Spinner } from "@/components/ui/spinner"
import type { VscodeWebviewRecord } from "@/lib/plugin/vscode-shim/webview-bridge"
import {
  connectWebviewFrame,
  prepareWebviewFrame,
  reportWebviewVisibility,
  type PreparedWebviewFrame,
} from "@/lib/plugin/vscode-shim/webview-handlers"

export interface VscodeWebviewFrameProps {
  webview: VscodeWebviewRecord
  /** This webview is the shown tab. */
  shown: boolean
}

export function VscodeWebviewFrame({ webview, shown }: VscodeWebviewFrameProps) {
  const t = useTranslations("plugins.vscodeWebviews")
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  // What was prepared, and for which document: a new revision shows loading
  // until its own preparation lands.
  const [result, setResult] = useState<{
    key: string
    prepared?: PreparedWebviewFrame
    failed?: boolean
  } | null>(null)
  const [onScreen, setOnScreen] = useState(true)
  const { handle, revision, title } = webview
  const key = `${handle}:${revision}`
  const prepared = result?.key === key ? (result.prepared ?? null) : null
  const failed = result?.key === key && result.failed === true

  useEffect(() => {
    let cancelled = false
    prepareWebviewFrame(handle).then(
      (next) => {
        if (!cancelled) setResult({ key: `${handle}:${revision}`, prepared: next })
      },
      () => {
        if (!cancelled) setResult({ key: `${handle}:${revision}`, failed: true })
      }
    )
    return () => {
      cancelled = true
    }
  }, [handle, revision])

  // Before the frame can parse its document, so the shell's first envelope
  // finds a listener.
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame || !prepared) return
    const connection = connectWebviewFrame(handle, prepared, (envelope) => {
      frame.contentWindow?.postMessage(envelope, "*")
    })
    const onMessage = (event: MessageEvent) => {
      if (event.source === frame.contentWindow) connection.receive(event.data)
    }
    window.addEventListener("message", onMessage)
    const theme = new MutationObserver(() => connection.updateTheme())
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    })
    return () => {
      theme.disconnect()
      window.removeEventListener("message", onMessage)
      connection.dispose()
    }
  }, [handle, prepared])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame || typeof IntersectionObserver === "undefined") return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setOnScreen(entry.isIntersecting)
      },
      { threshold: 0.01 }
    )
    observer.observe(frame)
    return () => observer.disconnect()
  }, [prepared])

  useEffect(() => {
    reportWebviewVisibility(handle, shown && onScreen)
  }, [handle, shown, onScreen])

  useEffect(() => () => reportWebviewVisibility(handle, false), [handle])

  if (failed) {
    return (
      <div
        data-testid="vscode-webview-failed"
        className="text-muted-foreground flex h-full items-center justify-center p-4 text-center text-sm"
      >
        {t("failed", { title })}
      </div>
    )
  }

  if (!prepared) {
    return (
      <div
        data-testid="vscode-webview-loading"
        className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm"
      >
        <Spinner className="size-4" />
        {t("loading", { title })}
      </div>
    )
  }

  return (
    <iframe
      ref={frameRef}
      // A new document for each preparation: a webview's html is replaced, not patched.
      key={key}
      title={title}
      srcDoc={prepared.srcDoc}
      // SECURITY: never allow-same-origin; the frame runs at an opaque origin.
      sandbox={prepared.sandbox}
      className="h-full w-full border-0 bg-transparent"
      data-vscode-webview={handle}
    />
  )
}
