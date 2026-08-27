// The real module rather than WXT's `#imports` virtual one. `#imports` only
// resolves through the generated `.wxt/` declarations, which this workspace
// excludes from its compile roots; importing the source of the one helper
// actually used keeps `tsc` honest without widening what it compiles.
import { defineBackground } from "wxt/utils/define-background"

import {
  CAPTURE_MENU_IDS,
  captureRequestForMenu,
  shouldOfferCaptureMenu,
} from "@ext/src/lib/capture/capture-request"
import { CAPTURE_REQUEST_KEY } from "@ext/src/lib/capture/capture-request"

/**
 * The service worker does as little as possible.
 *
 * MV3 reclaims it whenever it feels like it, so anything held in a module
 * variable here is a value that vanishes mid-flow with no event to notice it.
 * The connection, the draft, the captured page and the task list therefore all
 * live in the side panel, which is alive exactly while the user is looking at
 * it.
 *
 * What is left is the part only a worker can do: own the toolbar click and the
 * context menus, and record *that a capture was asked for* so the panel — which
 * may be opening for the first time in this browser session — can pick it up.
 * The request is a small, non-sensitive record (a tab id and a mode), not the
 * page itself; the panel does the extraction, because `activeTab` is granted to
 * the gesture and the panel is where the user reviews what it produced.
 */
export default defineBackground(() => {
  // Opening on the action click is what makes `chrome.sidePanel.open()`'s
  // user-gesture requirement somebody else's problem: Chrome treats the click
  // itself as the gesture.
  void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined)

  chrome.runtime.onInstalled.addListener(() => {
    // Recreated on every install/update rather than guarded: `contextMenus`
    // entries do not survive an update, and a duplicate-id create throws.
    void chrome.contextMenus?.removeAll().then(() => {
      chrome.contextMenus?.create({
        id: CAPTURE_MENU_IDS.selection,
        title: chrome.i18n.getMessage("contextMenuSelection"),
        contexts: ["selection"],
        documentUrlPatterns: ["http://*/*", "https://*/*"],
      })
      chrome.contextMenus?.create({
        id: CAPTURE_MENU_IDS.page,
        title: chrome.i18n.getMessage("contextMenuPage"),
        contexts: ["page"],
        documentUrlPatterns: ["http://*/*", "https://*/*"],
      })
    })
  })

  chrome.contextMenus?.onClicked.addListener((info, tab) => {
    if (!tab?.id || !shouldOfferCaptureMenu(tab.url ?? "")) return
    const request = captureRequestForMenu(String(info.menuItemId), tab.id, Date.now())
    if (!request) return
    void chrome.storage.local.set({ [CAPTURE_REQUEST_KEY]: request })
    void chrome.sidePanel?.open({ windowId: tab.windowId })
  })

  chrome.commands?.onCommand.addListener((command) => {
    if (command !== "capture-page") return
    void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const tab = tabs[0]
      if (!tab?.id || !shouldOfferCaptureMenu(tab.url ?? "")) return
      void chrome.storage.local.set({
        [CAPTURE_REQUEST_KEY]: { tabId: tab.id, mode: "auto", requestedAt: Date.now() },
      })
      void chrome.sidePanel?.open({ windowId: tab.windowId })
    })
  })
})
