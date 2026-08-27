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
import type { BrowserApi, ExtractionResult, TabRef } from "./browser-api"
import { extractFromDocument } from "./capture/extract-visible-text"

/** The one host permission this extension ever asks for. */
const LOOPBACK_ORIGIN = "http://127.0.0.1/*"

export function createChromeBrowserApi(): BrowserApi {
  return {
    async activeTab(): Promise<TabRef | null> {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!tab?.id || !tab.url) return null
      return { id: tab.id, url: tab.url, title: tab.title ?? "" }
    },

    async tabById(id): Promise<TabRef | null> {
      // `chrome.tabs.get` rejects rather than resolving null for a tab that
      // has closed, and a closed tab is an ordinary outcome here: the request
      // may have been recorded up to a minute ago.
      const tab = await chrome.tabs.get(id).catch(() => null)
      if (!tab?.id || !tab.url) return null
      return { id: tab.id, url: tab.url, title: tab.title ?? "" }
    },

    async extract(tabId, wholePage): Promise<ExtractionResult> {
      // `func` rather than `files`: the extractor is a pure function over the
      // live DOM, and injecting it by value keeps it in one module with its
      // tests instead of a separate bundle whose behaviour is asserted
      // indirectly. It cannot close over anything — `executeScript`
      // serializes it — which is why the whole extractor is self-contained.
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId },
        func: extractFromDocument,
        args: [wholePage],
      })
      const result = injected?.result as ExtractionResult | undefined
      if (!result) throw new Error("the page could not be read")
      return result
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
  }
}
