"use client"

/**
 * VS Code extension host bar — visibility-gated wrapper around the four
 * orphan extension-point components (`vscode.sidebar.view`,
 * `vscode.webview.panel`, `vscode.activity-bar`, `vscode.terminal.output`).
 *
 * The raw `VscodeExtensionPanel` and `VscodeTerminalPanel` components
 * always render *something* (an empty-state notice) so they can't be
 * dropped into a layout that should stay invisible when no extension
 * has registered yet. This bar is the polite mounter: it polls the
 * bridge and renders nothing at all when both stores are empty.
 *
 * Layout-wise the bar is a flex column — the host (chat shell / desktop
 * shell / mobile drawer) controls whether it sits on the right of the
 * editor, in a bottom panel, or in a settings tab. The bar itself is
 * agnostic.
 */

import { useEffect, useState } from "react"
import { listPanels, type WebviewRecord } from "@/lib/plugin/vscode-shim/webview-bridge"
import { listTerminals, type TerminalRecord } from "@/lib/plugin/vscode-shim/terminal-bridge"
import { VscodeExtensionPanel } from "./vscode-extension-panel"
import { VscodeTerminalPanel } from "./vscode-terminal-panel"

const POLL_INTERVAL_MS = 250

export interface VscodeExtensionHostBarProps {
  /**
   * Restrict the webview slot rendered by this instance. When omitted,
   * every registered webview panel is shown. Use `"sidebar"` for the
   * right-rail mount and `"panel"` for the centre area.
   */
  webviewSlot?: WebviewRecord["hostSlot"]
  /**
   * Hide the terminal sub-panel even when terminals exist. Lets the host
   * split the two surfaces across separate layout regions.
   */
  hideTerminal?: boolean
  /**
   * Hide the webview sub-panel. Mirror of `hideTerminal` for the other
   * direction.
   */
  hideWebviews?: boolean
  className?: string
}

/**
 * Subscribe to the bridge stores and re-render when either surface
 * becomes non-empty. Polls because the bridges don't currently emit a
 * change event — same pattern the inner components use.
 */
function useActiveExtensionSurfaces(slot?: WebviewRecord["hostSlot"]): {
  webviews: WebviewRecord[]
  terminals: TerminalRecord[]
} {
  const [webviews, setWebviews] = useState<WebviewRecord[]>(() =>
    slot ? listPanels().filter((p) => p.hostSlot === slot) : listPanels()
  )
  const [terminals, setTerminals] = useState<TerminalRecord[]>(() => listTerminals())
  useEffect(() => {
    let mounted = true
    const id = setInterval(() => {
      if (!mounted) return
      const w = slot ? listPanels().filter((p) => p.hostSlot === slot) : listPanels()
      const t = listTerminals()
      setWebviews((prev) => (sameIds(prev, w) ? prev : w))
      setTerminals((prev) => (sameIds(prev, t) ? prev : t))
    }, POLL_INTERVAL_MS)
    return () => {
      mounted = false
      clearInterval(id)
    }
  }, [slot])
  return { webviews, terminals }
}

function sameIds<T extends { panelId?: string; terminalId?: string }>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i]
    const bi = b[i]
    if ((ai?.panelId ?? ai?.terminalId) !== (bi?.panelId ?? bi?.terminalId)) return false
  }
  return true
}

export function VscodeExtensionHostBar({
  webviewSlot,
  hideTerminal,
  hideWebviews,
  className,
}: VscodeExtensionHostBarProps = {}) {
  const { webviews, terminals } = useActiveExtensionSurfaces(webviewSlot)
  const showWebviews = !hideWebviews && webviews.length > 0
  const showTerminal = !hideTerminal && terminals.length > 0
  if (!showWebviews && !showTerminal) return null
  return (
    <div
      data-testid="vscode-extension-host-bar"
      className={`flex h-full w-full flex-col gap-2 ${className ?? ""}`}
    >
      {showWebviews ? (
        <div className="min-h-0 flex-1" data-testid="vscode-extension-host-bar-webviews">
          <VscodeExtensionPanel slot={webviewSlot} />
        </div>
      ) : null}
      {showTerminal ? (
        <div className="min-h-[8rem] flex-1" data-testid="vscode-extension-host-bar-terminal">
          <VscodeTerminalPanel />
        </div>
      ) : null}
    </div>
  )
}
