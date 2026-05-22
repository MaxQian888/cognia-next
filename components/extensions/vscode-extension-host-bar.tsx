"use client"

/**
 * VS Code extension host bar — visibility-gated wrapper around the
 * extension-point WebView panels (`vscode.sidebar.view`,
 * `vscode.webview.panel`, `vscode.activity-bar`).
 *
 * Terminal output used to be a fourth slot here (`vscode.terminal.output`)
 * but the integrated terminal dock now owns every terminal — both
 * user-spawned and extension-spawned. The bridge's `createTerminal` API
 * still works for VS Code extensions; their sessions just appear as new
 * tabs in `<TerminalDock>` instead of in a separate panel. See plan
 * `vscode-vivid-wilkinson.md` §Reuse map row #9.
 *
 * The raw `VscodeExtensionPanel` always renders *something* (an
 * empty-state notice) so it can't be dropped into a layout that should
 * stay invisible when no extension has registered yet. This bar is the
 * polite mounter: it polls the bridge and renders nothing at all when
 * no webview is active.
 */

import { useEffect, useState } from "react"
import { listPanels, type WebviewRecord } from "@/lib/plugin/vscode-shim/webview-bridge"
import { VscodeExtensionPanel } from "./vscode-extension-panel"

const POLL_INTERVAL_MS = 250

export interface VscodeExtensionHostBarProps {
  /**
   * Restrict the webview slot rendered by this instance. When omitted,
   * every registered webview panel is shown. Use `"sidebar"` for the
   * right-rail mount and `"panel"` for the centre area.
   */
  webviewSlot?: WebviewRecord["hostSlot"]
  className?: string
}

/**
 * Subscribe to the webview-bridge store and re-render when it becomes
 * non-empty. Polls because the bridge doesn't currently emit a change
 * event — same pattern the inner component uses.
 */
function useActiveWebviews(slot?: WebviewRecord["hostSlot"]): WebviewRecord[] {
  const [webviews, setWebviews] = useState<WebviewRecord[]>(() =>
    slot ? listPanels().filter((p) => p.hostSlot === slot) : listPanels()
  )
  useEffect(() => {
    let mounted = true
    const id = setInterval(() => {
      if (!mounted) return
      const w = slot ? listPanels().filter((p) => p.hostSlot === slot) : listPanels()
      setWebviews((prev) => (sameIds(prev, w) ? prev : w))
    }, POLL_INTERVAL_MS)
    return () => {
      mounted = false
      clearInterval(id)
    }
  }, [slot])
  return webviews
}

function sameIds(a: WebviewRecord[], b: WebviewRecord[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]?.panelId !== b[i]?.panelId) return false
  }
  return true
}

export function VscodeExtensionHostBar({
  webviewSlot,
  className,
}: VscodeExtensionHostBarProps = {}) {
  const webviews = useActiveWebviews(webviewSlot)
  if (webviews.length === 0) return null
  return (
    <div
      data-testid="vscode-extension-host-bar"
      className={`flex h-full w-full flex-col gap-2 ${className ?? ""}`}
    >
      <div className="min-h-0 flex-1" data-testid="vscode-extension-host-bar-webviews">
        <VscodeExtensionPanel slot={webviewSlot} />
      </div>
    </div>
  )
}
