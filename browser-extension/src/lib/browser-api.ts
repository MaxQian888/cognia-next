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

import type { BrowserTranscriptV1 } from "@cognia/companion-client"
import type { SiteAnswer } from "./agent/site-permissions"
import type { PageCapture, PageCaptureOptions } from "./capture/page-capture"

export interface TabRef {
  id: number
  url: string
  title: string
  /** The window the tab is in; a visible-area capture is per window. */
  windowId?: number
}

/** Optional permissions the panel asks for inside the person's click. */
export interface PermissionRequest {
  permissions?: ("tabs" | "notifications" | "downloads" | "cookies")[]
  origins?: string[]
}

/** A scroll position and the page's size, for a full-page screenshot. */
export interface ScrollMetrics {
  scrollHeight: number
  viewportHeight: number
  viewportWidth: number
  scrollY: number
  dpr: number
}

/** The port the side panel holds open to the worker while it is open. */
export const PANEL_PORT = "cognia-panel"

/** The open port to the service worker; closing the panel closes it. */
export interface PanelPort {
  post(message: { kind: "refresh-status" }): void
  disconnect(): void
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
  capturePage(tabId: number, options: PageCaptureOptions): Promise<PageCapture>
  /** MAIN world; resolves unavailable/not_a_video off YouTube. */
  captureTranscript(tabId: number, preferredLanguage: string): Promise<BrowserTranscriptV1>
  /** Read a value from `chrome.storage.local`. */
  read<T>(key: string): Promise<T | null>
  /** Write a value to `chrome.storage.local`. */
  write(key: string, value: unknown): Promise<void>
  /** Remove keys from `chrome.storage.local`. */
  remove(keys: string[]): Promise<void>
  /**
   * Be told when one `chrome.storage.local` key changes, for as long as the
   * returned function has not been called.
   *
   * The listener receives the new value, or `null` when the key was removed.
   * It exists for the capture request: the background worker writes one when
   * the user picks a context-menu entry, and a panel that is ALREADY open has
   * no mount to read it on — reading only on mount left those gestures
   * waiting until the panel happened to be reopened.
   */
  onStorageChange(key: string, listener: (value: unknown) => void): () => void
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

  /** `chrome.storage.session` — memory only (ADR-0228 §8). */
  readSession<T>(key: string): Promise<T | null>
  writeSession(key: string, value: unknown): Promise<void>
  removeSession(keys: string[]): Promise<void>
  onSessionChange(key: string, listener: (value: unknown) => void): () => void

  hasPermissions(request: PermissionRequest): Promise<boolean>
  /** Must run inside a user gesture. */
  requestPermissions(request: PermissionRequest): Promise<boolean>
  removePermissions(request: PermissionRequest): Promise<boolean>

  /** The tabs of the panel's window. Needs the optional `tabs` permission. */
  listTabs(): Promise<TabRef[]>
  /** The visible area of a window's active tab, as a PNG data URL. */
  captureVisible(windowId: number): Promise<string>
  /** Make a tab the active one in its window. */
  activateTab(tabId: number): Promise<void>
  scrollMetrics(tabId: number): Promise<ScrollMetrics>
  /** Scroll to `y`; answers where the page actually landed. */
  scrollTo(tabId: number, y: number): Promise<number>
  /** Crop a capture, in device pixels; base64 PNG without the prefix. */
  cropImage(
    dataUrl: string,
    rect: { x: number; y: number; width: number; height: number }
  ): Promise<string>
  /** Stack captures top to bottom, keeping the bottom `heights[i]` rows of each. */
  stitchImages(dataUrls: string[], width: number, heights: number[]): Promise<string>
  /** Fetch a URL's bytes from the extension (needs its origin granted). */
  fetchBytes(url: string, maxBytes: number): Promise<{ bytes: Uint8Array; mediaType: string }>

  /** Hold a port to the worker while the panel is open. */
  connectPanel(): PanelPort
  /** Answer a pending site question (ADR-0228 §7), inside the person's click. */
  answerSiteQuestion(questionId: string, answer: SiteAnswer): Promise<void>
  /** Forget a standing site decision. */
  forgetSiteDecision(origin: string): Promise<void>
}

/**
 * The keys this extension stores, and the fact that none of them is content.
 *
 * `chrome.storage.local` is not a vault: it is readable by anything that can
 * read the profile directory. So it holds the public half of the pairing (the
 * base URL, the tenant, the device id), the appearance the Host last sent, the
 * person's preferences and the instructions they chose to save. The private key
 * lives in IndexedDB as a non-extractable `CryptoKey`; access tokens live in
 * memory; captured page text lives in the panel's React state and, for an
 * unsent draft, in `chrome.storage.session` ({@link SESSION_KEYS}) — never here.
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
  /** Notifications, agent mode and sites never to capture (`preferences.ts`). */
  preferences: "cognia.preferences.v1",
  /** The person's saved instructions — their own text, not page content. */
  savedPrompts: "cognia.savedPrompts.v1",
} as const

/**
 * Keys in `chrome.storage.session`: memory only, gone when the browser exits
 * and never written to the profile (ADR-0228 §8). The unsent draft is the one
 * place captured page content is kept outside the panel's React state, and
 * this is why it may be.
 */
export const SESSION_KEYS = {
  /** The unsent capture and its instruction (`drafts.ts`). */
  draft: "cognia.draft.v1",
  /** The device socket's state, written by the worker for the panel. */
  socketState: "cognia.socketState.v1",
  /** When the Host last said a submission moved; the panel refreshes on change. */
  statusHint: "cognia.statusHint.v1",
} as const

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS]
