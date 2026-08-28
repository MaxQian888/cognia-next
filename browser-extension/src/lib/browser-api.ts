/**
 * The extension APIs this side panel uses, as one injectable surface.
 *
 * Two reasons it is not `import { browser } from "wxt/browser"` at every call
 * site. The first is testing: root Jest collects this workspace's suites, and a
 * WXT virtual module does not resolve there — an unresolvable import kills the
 * whole suite silently rather than failing one test. The second is that a
 * narrow, hand-written surface is a readable statement of what the extension
 * can actually do; `chrome.*` in scattered call sites is not.
 *
 * Nothing under `src/lib` or `src/components` imports `wxt/browser` or
 * `#imports`. The entrypoints under `src/app` do, and pass the real thing in.
 */

export interface TabRef {
  id: number
  url: string
  title: string
}

export interface ExtractionResult {
  title: string
  url: string
  selection: string | null
  readableText: string | null
  readableCharacterCount: number
}

export interface BrowserApi {
  /** The active tab, or `null` when there is none we may touch. */
  activeTab(): Promise<TabRef | null>
  /**
   * One tab by id, or `null` when it is gone.
   *
   * Separate from {@link activeTab} because a capture the background worker
   * recorded names the tab the user gestured on, and by the time the panel
   * opens the active tab may be a different one — or the panel itself.
   */
  tabById(id: number): Promise<TabRef | null>
  /** Run the extractor in `tabId` and return what it found. */
  extract(tabId: number, wholePage: boolean): Promise<ExtractionResult>
  /** Read a value from `chrome.storage.local`. */
  read<T>(key: string): Promise<T | null>
  /** Write a value to `chrome.storage.local`. */
  write(key: string, value: unknown): Promise<void>
  /** Remove keys from `chrome.storage.local`. */
  remove(keys: string[]): Promise<void>
  /** Whether the loopback host permission has been granted. */
  hasLoopbackPermission(): Promise<boolean>
  /** Ask for the loopback host permission. Must run in a user gesture. */
  requestLoopbackPermission(): Promise<boolean>
  /** This extension's own origin, e.g. `chrome-extension://<id>`. */
  extensionOrigin(): string
  /** Open a URL in a new tab. */
  openUrl(url: string): Promise<void>
  /** A localized message from `_locales`. */
  message(key: string, substitutions?: string[]): string
}

/**
 * The keys this extension stores, and the fact that none of them is content.
 *
 * `chrome.storage.local` is not a vault: it is readable by anything that can
 * read the profile directory. So it holds the public half of the pairing (the
 * base URL, the tenant, the device id), the appearance the Host last sent, and
 * one UI preference. The private key lives in IndexedDB as a non-extractable
 * `CryptoKey`; access tokens live in memory; captured page text lives in the
 * panel's React state and nowhere else.
 */
export const STORAGE_KEYS = {
  /** `{ baseUrl, tenantId, deviceId, extensionOrigin, pairedAt }`. */
  pairing: "cognia.pairing.v1",
  /** The Host's last-sent appearance, so the first paint is not wrong. */
  appearance: "cognia.appearance.v1",
  /** The workspace the user last aimed a submission at. */
  lastWorkspaceId: "cognia.workspace.v1",
  /** A submission whose response never arrived, awaiting a safe retry. */
  pendingSubmission: "cognia.pending.v1",
  /** `follow-host` | `light` | `dark` — how the panel is themed. */
  appearanceOverride: "cognia.appearanceOverride.v1",
} as const

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS]
