/**
 * Where a pane's element picks come from (ADR-0214). Both engines run the same
 * injected overlay; they differ only in how the page's "I buffered N picks"
 * signal reaches the app and how the picks are read back:
 *
 * - the embedded webview signals through a sentinel navigation Rust turns into
 *   `browser://element-selected`, and is driven through `browser_embed_*`;
 * - local Chromium signals through a Playwright binding the runtime forwards
 *   as an `element.selected` event, and is driven through dedicated runtime
 *   ops on the page the pane shows.
 */
import { browserClient } from "@/lib/browser/client"
import type { LocalChromiumEngine, SelectionPanelLabels } from "@/lib/browser/local-chromium-engine"
import { localBrowser } from "@/lib/browser/local-client"
import {
  BROWSER_EVENTS,
  type BrowserNavigated,
  type BrowserSelection,
  type BrowserSelectionSignal,
} from "@/lib/browser/protocol"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

export interface ElementSelectionHandlers {
  /** The page buffered `count` picks; drain them. */
  onSignal(signal: BrowserSelectionSignal): void
  /** The page's document changed: its pick generations start over. */
  onNavigated(navigated: BrowserNavigated): void
}

export interface ElementSelectionSource {
  /** Arm or disarm the in-page picker. */
  setSelectMode(on: boolean): Promise<void>
  /** Read and empty the page's pick buffer (a one-shot read). */
  drain(): Promise<BrowserSelection[]>
  /** Drop the picks and the in-page info panel (comment sent or cancelled). */
  clear(): Promise<void>
  /** Start listening; resolves the function that stops it. */
  subscribe(handlers: ElementSelectionHandlers): Promise<() => void>
}

/** The lightweight preview (embedded webview). */
export const embeddedSelectionSource: ElementSelectionSource = {
  setSelectMode: (on) => browserClient.embedSetSelectMode(on),
  drain: () => browserClient.embedDrainSelection(),
  clear: () => browserClient.embedClearSelection(),
  async subscribe({ onSignal, onNavigated }) {
    const unlisteners: Array<() => void> = []
    try {
      unlisteners.push(
        await onTauriEvent<BrowserSelectionSignal>(BROWSER_EVENTS.elementSelected, onSignal)
      )
      unlisteners.push(await onTauriEvent<BrowserNavigated>(BROWSER_EVENTS.navigated, onNavigated))
    } catch (error) {
      for (const unlisten of unlisteners) safeUnlisten(unlisten)
      throw error
    }
    return () => {
      for (const unlisten of unlisteners) safeUnlisten(unlisten)
    }
  },
}

/** The `paneId` the runtime stamps on a local page's picks. */
export function localSelectionPaneId(pageId: string): string {
  return `local:${pageId}`
}

/**
 * Local Chromium (and the user's Chrome): picks on `pageId`, the page the pane
 * shows, through `engine`. Signals from other pages of the shared session
 * belong to other panes and are ignored.
 */
export function localSelectionSource(
  engine: Pick<
    LocalChromiumEngine,
    "sessionId" | "setSelectMode" | "drainSelection" | "clearSelection"
  >,
  pageId: string,
  labels?: SelectionPanelLabels
): ElementSelectionSource {
  return {
    setSelectMode: (on) => engine.setSelectMode(on, on ? labels : undefined),
    drain: () => engine.drainSelection(),
    clear: () => engine.clearSelection(),
    // The runtime numbers a page's signals itself, across reloads and
    // navigations, so there is no generation restart to report: `onNavigated`
    // is the embedded webview's concern.
    async subscribe({ onSignal }) {
      return localBrowser.onEvent((event) => {
        if (event.type !== "element.selected") return
        if (event.sessionId !== engine.sessionId || event.pageId !== pageId) return
        onSignal({
          paneId: localSelectionPaneId(pageId),
          count: event.count,
          generation: event.generation,
        })
      })
    },
  }
}
