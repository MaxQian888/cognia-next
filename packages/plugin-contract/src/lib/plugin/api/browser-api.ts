/**
 * The plugin contract's share of `lib/plugin/api/browser-api.ts`, which re-exports these.
 */
import type { BrowserAnnotationRow } from "../../db/browser-annotations"
import type { BrowserBackend } from "../../browser/backend-availability"
import type { BrowserDownloadSummary } from "../../browser/session-types"
import type {
  BrowserEngine,
  BrowserEngineBackend,
  EngineBackendPreference,
} from "../../browser/agent-engine"

import type { TrustTier } from "../../browser/protocol"

export type PrivilegedBrowserEngineMethod = (typeof PRIVILEGED_BROWSER_ENGINE_METHODS)[number]

/**
 * The engine a plugin receives. Every other plugin gets a facade WITHOUT the
 * privileged methods (absent at runtime, optional here), and whose `evaluate`
 * never forwards the post-fill approval flag. The first-party plugin receives
 * the engine itself.
 */
export type PluginBrowserEngine = Omit<BrowserEngine, PrivilegedBrowserEngineMethod> &
  Partial<Pick<BrowserEngine, PrivilegedBrowserEngineMethod>>

export interface PluginBrowserRoute {
  /** The full engine for the first-party Browser Tools; a facade for every other plugin. */
  engine: PluginBrowserEngine
  tier: TrustTier
  untrusted: boolean
  /** Which engine the router picked (ADR-0201). */
  backend?: BrowserEngineBackend
}

export interface PluginBrowserRoutingContext {
  domainAuthorized?: boolean
  /** A per-chat backend choice made with `browser_open` (ADR-0201). */
  backendPreference?: EngineBackendPreference
  /**
   * The conversation the call is for: on local Chromium each conversation
   * drives its own page (ADR-0214).
   */
  chatSessionId?: string
}

export interface PluginBrowserAPI {
  routeEngine(url: string, context?: PluginBrowserRoutingContext): PluginBrowserRoute
  isDomainAuthorized(url: string): boolean
  primeDomainGrants(): Promise<string[]>
  saveAnnotation(annotation: BrowserAnnotationRow): Promise<void>
  /** Warm the "local Chromium installed" snapshot `routeEngine` reads. */
  primeLocalRouting(): Promise<void>
  /** Create (once) or reuse the agent's local runtime session for a backend. */
  ensureLocalEngine(
    backend: "local-chromium" | "user-chrome",
    options?: { headless?: boolean; browser?: string; chatSessionId?: string }
  ): Promise<PluginBrowserEngine>
  /**
   * Ask the browser pane to show `url` (empty: whatever it has open) on
   * `backend`, for `chatSessionId`'s page. True when a pane or a host
   * revealing one took the request.
   */
  openPane(url: string, options?: { backend?: BrowserBackend; chatSessionId?: string }): boolean
  /** Hand a finished download to the composer of `chatSessionId`. */
  attachDownload(download: BrowserDownloadSummary, chatSessionId: string): boolean
  /** Whether a person can currently see the app window. */
  isSurfaceVisible(): boolean
}

/**
 * Engine methods only the first-party Browser Tools plugin receives. They put a
 * vault password into a page, or return a site's session state (storage
 * values, request bodies, cookie metadata) or wipe it (cookies) — the plugin
 * gates each behind an approval / trust check; any other plugin would not.
 */
export const PRIVILEGED_BROWSER_ENGINE_METHODS = [
  "fillCredential",
  "getStorage",
  "networkRequest",
  "listCookies",
  "clearCookies",
] as const
