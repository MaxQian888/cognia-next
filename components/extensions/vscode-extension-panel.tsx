"use client"

/**
 * Sidebar / activity-bar host for VS Code extension WebviewViews.
 *
 * The cognia plugin extension points `vscode.sidebar.view`,
 * `vscode.webview.panel`, and `vscode.activity-bar` mount this component.
 * It renders an iframe sandbox for each registered webview panel and
 * wires it into `webview-bridge.ts` so the sidecar's extension code can
 * drive `webview.html`, `postMessage`, `onDidReceiveMessage`, and
 * `onDidChangeViewState`.
 *
 * The iframe runs in a `sandbox="allow-scripts"` jail — no `allow-same-origin`
 * — so the webview can't reach renderer globals. Cross-frame communication
 * is `window.postMessage` only.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  acquireVsCodeApiPolyfillSource,
  attachHostFrame,
  detachHostFrame,
  disposeWebviewPanel,
  listPanels,
  notifyViewStateChange,
  setState as setWebviewPanelState,
  type HostFrame,
  type WebviewMessage,
  type WebviewRecord,
} from "@/lib/plugin/vscode-shim/webview-bridge"

interface VscodeExtensionPanelProps {
  /**
   * Slot filter. When set, only panels whose `hostSlot` matches will be
   * rendered. Lets the host mount three independent panels (left sidebar,
   * right sidebar, bottom panel) without showing duplicates.
   */
  slot?: WebviewRecord["hostSlot"]
}

export function VscodeExtensionPanel({ slot }: VscodeExtensionPanelProps) {
  const t = useTranslations("plugins.vscodeWebviews")
  const panels = useWebviewPanels(slot)
  if (panels.length === 0) {
    return (
      <div
        className="flex h-full w-full items-center justify-center text-sm text-muted-foreground"
        data-testid="vscode-extension-panel-empty"
      >
        {t("empty")}
      </div>
    )
  }
  return (
    <div className="flex h-full w-full flex-col" data-testid="vscode-extension-panel">
      {panels.map((p) => (
        <VscodeWebviewIframe key={p.panelId} panel={p} />
      ))}
    </div>
  )
}

function VscodeWebviewIframe({ panel }: { panel: WebviewRecord }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  // Build the iframe srcDoc once on mount; subsequent setHtml() goes through
  // the bridge → frame.setSrcDoc → iframe.srcdoc update path.
  // panel.html is intentionally NOT in the deps — re-running the memo on
  // every html change would force a full iframe remount and drop the
  // webview's runtime state. The bridge handles incremental updates.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initialSrcDoc = useMemo(() => wrapHtmlForWebview(panel.html), [panel.panelId])

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    const messageListeners: Array<(msg: WebviewMessage) => void> = []
    let stateFromWebview: unknown = undefined

    const frame: HostFrame = {
      panelId: panel.panelId,
      setSrcDoc: (html) => {
        iframe.srcdoc = wrapHtmlForWebview(html)
      },
      post: (msg) => {
        iframe.contentWindow?.postMessage(
          { __cogniaWebviewKind: "host-message", data: msg.data },
          "*"
        )
      },
      onMessage: (listener) => {
        messageListeners.push(listener)
        return () => {
          const idx = messageListeners.indexOf(listener)
          if (idx >= 0) messageListeners.splice(idx, 1)
        }
      },
      destroy: () => {
        iframe.srcdoc = "about:blank"
      },
    }

    const onWindowMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return
      const payload = event.data as
        { __cogniaWebviewKind?: string; data?: unknown; state?: unknown } | undefined
      if (!payload || typeof payload !== "object") return
      if (payload.__cogniaWebviewKind === "post" && payload.data !== undefined) {
        for (const listener of messageListeners) {
          try {
            listener({ data: payload.data })
          } catch (err) {
            // Listeners must not throw across the bridge boundary.

            console.warn(`vscode-extension-panel: listener threw for ${panel.panelId}:`, err)
          }
        }
      } else if (payload.__cogniaWebviewKind === "set-state") {
        stateFromWebview = payload.state
        // Mirror into the bridge so the next mount (after detach/reattach)
        // can rehydrate.
        setWebviewPanelState(panel.panelId, stateFromWebview)
      }
    }

    window.addEventListener("message", onWindowMessage)
    attachHostFrame(panel.panelId, frame)

    // Notify viewstate visible+active on mount; visibility tracking is
    // delegated to IntersectionObserver below.
    notifyViewStateChange(panel.panelId, true, true)

    let observer: IntersectionObserver | undefined
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            notifyViewStateChange(panel.panelId, entry.isIntersecting, entry.isIntersecting)
          }
        },
        { threshold: 0.01 }
      )
      observer.observe(iframe)
    }

    return () => {
      observer?.disconnect()
      window.removeEventListener("message", onWindowMessage)
      detachHostFrame(panel.panelId)
    }
  }, [panel.panelId])

  return (
    <div
      className="flex h-full w-full flex-col border-b last:border-b-0"
      data-testid={`vscode-webview-${panel.panelId}`}
    >
      <header className="flex items-center justify-between border-b bg-muted/30 px-2 py-1 text-xs font-medium">
        <span className="truncate" title={panel.title}>
          {panel.title}
        </span>
        <button
          type="button"
          aria-label={`Close ${panel.title}`}
          onClick={() => disposeWebviewPanel(panel.panelId)}
          className="rounded px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          ×
        </button>
      </header>
      <iframe
        ref={iframeRef}
        title={panel.title}
        srcDoc={initialSrcDoc}
        sandbox="allow-scripts"
        className="flex-1 border-0"
        data-extension-id={panel.extensionId}
      />
    </div>
  )
}

/**
 * Wrap a webview HTML body with:
 *   - the cognia CSP (matches VS Code semantics — strict by default)
 *   - the `acquireVsCodeApi()` polyfill
 *   - a default `<base target="_self">` so links don't try to navigate the iframe
 */
function wrapHtmlForWebview(rawHtml: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https:;" />
<base target="_self" />
<script>${acquireVsCodeApiPolyfillSource()}</script>
</head>
<body>
${rawHtml}
</body>
</html>`
}

/**
 * Subscribe to the webview-bridge panel list. Re-renders when panels are
 * added or removed. Uses polling against `listPanels()` because the bridge
 * doesn't expose a global change emitter (only per-panel dispose).
 *
 * 250ms is enough to feel responsive without dominating the event loop —
 * extensions register panels infrequently (once per activate()).
 */
function useWebviewPanels(slot?: WebviewRecord["hostSlot"]): WebviewRecord[] {
  const [panels, setPanels] = useState<WebviewRecord[]>(() => filterBySlot(listPanels(), slot))
  useEffect(() => {
    let mounted = true
    const id = setInterval(() => {
      if (!mounted) return
      const next = filterBySlot(listPanels(), slot)
      setPanels((prev) => (panelsShallowEqual(prev, next) ? prev : next))
    }, 250)
    return () => {
      mounted = false
      clearInterval(id)
    }
  }, [slot])
  return panels
}

function filterBySlot(
  panels: WebviewRecord[],
  slot: WebviewRecord["hostSlot"] | undefined
): WebviewRecord[] {
  if (!slot) return panels
  return panels.filter((p) => p.hostSlot === slot)
}

function panelsShallowEqual(a: WebviewRecord[], b: WebviewRecord[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]!.panelId !== b[i]!.panelId) return false
    if (a[i]!.disposed !== b[i]!.disposed) return false
    if (a[i]!.title !== b[i]!.title) return false
  }
  return true
}
