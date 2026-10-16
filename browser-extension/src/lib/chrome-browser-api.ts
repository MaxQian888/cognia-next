/**
 * The real `chrome.*` implementation of {@link BrowserApi}.
 *
 * The only module in the extension that touches the extension APIs directly,
 * which is what makes the rest of it testable and what makes the permission
 * surface readable: everything the extension can do to the browser is one
 * file's worth of calls.
 *
 * `chrome.*` rather than WXT's `browser` wrapper. The extension ships to
 * Chrome and Edge only, and the wrapper re-types `i18n.getMessage` and
 * `runtime.getURL` into signatures generated from `_locales`, which is a build
 * step this module has no reason to depend on.
 */
import { createAgentStores } from "./agent/agent-runtime"
import { chromeStorageArea } from "./agent/chrome-agent-browser"
import { browserImageOps } from "./agent/image-ops"
import { pageScrollMetrics, pageScrollTo } from "./agent/page-functions"
import { PANEL_PORT, type BrowserApi, type PermissionRequest, type TabRef } from "./browser-api"
import { isYouTubeWatchUrl, readYouTubeTranscript } from "./capture/youtube-transcript"

/** The one host permission this extension ever asks for. */
const LOOPBACK_ORIGIN = "http://127.0.0.1/*"

function tabRef(tab: chrome.tabs.Tab | null | undefined): TabRef | null {
  if (!tab?.id || !tab.url) return null
  return { id: tab.id, url: tab.url, title: tab.title ?? "", windowId: tab.windowId }
}

function permissions(request: PermissionRequest): chrome.permissions.Permissions {
  return {
    ...(request.permissions
      ? { permissions: request.permissions as chrome.permissions.Permissions["permissions"] }
      : {}),
    ...(request.origins ? { origins: request.origins } : {}),
  }
}

export function createChromeBrowserApi(): BrowserApi {
  const session = chromeStorageArea("session")
  // Built on first use: the panel only needs the agent stores to answer a
  // question or forget a decision, and both touch `chrome.storage` only then.
  let stores: ReturnType<typeof createAgentStores> | null = null
  const agentStores = () =>
    (stores ??= createAgentStores({
      local: chromeStorageArea("local"),
      session,
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
      // The panel answers questions; it never asks one.
      onQuestion: () => undefined,
    }))
  const image = browserImageOps()

  return {
    async activeTab(): Promise<TabRef | null> {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      return tabRef(tab)
    },

    async tabById(id): Promise<TabRef | null> {
      // `chrome.tabs.get` rejects rather than resolving null for a tab that
      // has closed, and a closed tab is an ordinary outcome here: the request
      // may have been recorded up to a minute ago.
      return tabRef(await chrome.tabs.get(id).catch(() => null))
    },

    async capturePage(tabId, options) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["/page-capture.js"] })
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId },
        func: (opts) => globalThis.__cogniaPageCapture?.capture(opts),
        args: [options],
      })
      if (!injected?.result) throw new Error("the page could not be read")
      return injected.result
    },

    async captureTranscript(tabId, preferredLanguage) {
      const tab = await chrome.tabs.get(tabId)
      if (!isYouTubeWatchUrl(tab.url ?? "")) return { status: "unavailable", reason: "not_a_video" }
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: readYouTubeTranscript,
        args: [preferredLanguage],
      })
      return injected?.result ?? { status: "unavailable", reason: "fetch_failed" }
    },

    async read<T>(key: string): Promise<T | null> {
      const stored = await chrome.storage.local.get(key)
      return (stored[key] as T | undefined) ?? null
    },

    async write(key, value) {
      await chrome.storage.local.set({ [key]: value })
    },

    async remove(keys) {
      await chrome.storage.local.remove(keys)
    },

    onStorageChange(key, listener) {
      // `chrome.storage.onChanged` fires for every area; only `local` is ours.
      // `newValue` is absent on a removal, which the contract reports as null
      // rather than `undefined` so a listener has one "gone" to check for.
      const handler = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
        if (areaName !== "local" || !Object.hasOwn(changes, key)) return
        listener(changes[key]?.newValue ?? null)
      }
      chrome.storage.onChanged.addListener(handler)
      return () => chrome.storage.onChanged.removeListener(handler)
    },

    async hasLoopbackPermission() {
      return chrome.permissions.contains({ origins: [LOOPBACK_ORIGIN] })
    },

    async requestLoopbackPermission() {
      // Must be called inside a user gesture; Chrome rejects it otherwise.
      // The panel only ever calls this from the pairing button's handler.
      return chrome.permissions.request({ origins: [LOOPBACK_ORIGIN] })
    },

    extensionOrigin() {
      // Trailing slash trimmed off `getURL("/")`, NOT `new URL(...).origin`.
      // `chrome-extension:` is not a special scheme in the URL Standard, so a
      // URL built from it has an *opaque* origin and `.origin` serializes to
      // the string `"null"`. Chrome's own page context happens to report a
      // tuple origin, but the URL API is the spec's and would have handed the
      // Host the literal text "null" to store and compare against.
      return chrome.runtime.getURL("/").replace(/\/+$/, "")
    },

    async openUrl(url) {
      await chrome.tabs.create({ url })
    },

    message(key, substitutions) {
      return chrome.i18n.getMessage(key, substitutions)
    },

    readSession: (key) => session.get(key),
    writeSession: (key, value) => session.set(key, value),
    async removeSession(keys) {
      await chrome.storage.session.remove(keys)
    },
    onSessionChange: (key, listener) => session.onChange(key, listener),

    hasPermissions: (request) => chrome.permissions.contains(permissions(request)),
    requestPermissions: (request) => chrome.permissions.request(permissions(request)),
    removePermissions: (request) => chrome.permissions.remove(permissions(request)),

    async listTabs() {
      const tabs = await chrome.tabs.query({ currentWindow: true })
      return tabs.map(tabRef).filter((tab): tab is TabRef => tab !== null)
    },

    captureVisible: (windowId) => chrome.tabs.captureVisibleTab(windowId, { format: "png" }),

    async activateTab(tabId) {
      await chrome.tabs.update(tabId, { active: true })
    },

    async scrollMetrics(tabId) {
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageScrollMetrics,
      })
      if (!injected?.result) throw new Error("the page could not be measured")
      return injected.result
    },

    async scrollTo(tabId, y) {
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId },
        func: pageScrollTo,
        args: [y],
      })
      return typeof injected?.result === "number" ? injected.result : y
    },

    cropImage: (dataUrl, rect) => image.crop(dataUrl, rect),
    stitchImages: (dataUrls, width, heights) => image.stitch(dataUrls, width, heights),

    async fetchBytes(url, maxBytes) {
      // `omit`: the bytes are the page's resource, not a request made as the
      // person; their cookies have no business riding along.
      const response = await fetch(url, { credentials: "omit", redirect: "follow" })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const declared = Number(response.headers.get("content-length") ?? "0")
      if (declared > maxBytes) throw new Error("too_large")
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > maxBytes) throw new Error("too_large")
      const mediaType =
        (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
      return { bytes, mediaType }
    },

    connectPanel() {
      const port = chrome.runtime.connect({ name: PANEL_PORT })
      return {
        post: (message) => port.postMessage(message),
        disconnect: () => port.disconnect(),
      }
    },

    answerSiteQuestion: (questionId, answer) =>
      agentStores().permissions.answer(questionId, answer),
    forgetSiteDecision: (origin) => agentStores().permissions.setDecision(origin, null),
  }
}
