import {
  ensureAgentLocalEngine,
  primeLocalBrowserRouting,
  routeEngine,
  type BrowserEngine,
  type BrowserEngineBackend,
  type EngineBackendPreference,
} from "@/lib/browser/agent-engine"
import type { BrowserBackend } from "@/lib/browser/backend-availability"
import {
  isBrowserDomainAuthorized,
  primeBrowserDomainGrants,
} from "@/lib/browser/domain-authorization"
import { requestBrowserDownloadAttach } from "@/lib/browser/downloads-client"
import { isBrowserSurfaceVisible, requestBrowserUrl } from "@/lib/browser/open-url-request"
import type { TrustTier } from "@/lib/browser/protocol"
import type { BrowserDownloadSummary } from "@/lib/browser/session-types"
import { saveBrowserAnnotation, type BrowserAnnotationRow } from "@/lib/db/browser-annotations"
import type { PluginSource } from "@/types/plugin"

/**
 * The one plugin that receives the full engine (ADR-0201): the bundled Browser
 * Tools plugin, which wraps every privileged method in its own approval and
 * trust checks. Recognised by id AND `source: "builtin"`, which only the
 * manager's bundled-plugin discovery assigns, so a local or marketplace plugin
 * reusing the id does not qualify.
 */
export const FIRST_PARTY_BROWSER_PLUGIN_ID = "cognia-browser-tools"

export function isFirstPartyBrowserPlugin(pluginId: string, source: PluginSource | undefined) {
  return pluginId === FIRST_PARTY_BROWSER_PLUGIN_ID && source === "builtin"
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

type PrivilegedBrowserEngineMethod = (typeof PRIVILEGED_BROWSER_ENGINE_METHODS)[number]

/**
 * The engine a plugin receives. Every other plugin gets a facade WITHOUT the
 * privileged methods (absent at runtime, optional here), and whose `evaluate`
 * never forwards the post-fill approval flag. The first-party plugin receives
 * the engine itself.
 */
export type PluginBrowserEngine = Omit<BrowserEngine, PrivilegedBrowserEngineMethod> &
  Partial<Pick<BrowserEngine, PrivilegedBrowserEngineMethod>>

/** Methods the facade forwards unchanged (`evaluate` is forwarded with its options dropped). */
const FACADE_METHODS = [
  "navigate",
  "snapshot",
  "act",
  "pressKey",
  "scroll",
  "readConsole",
  "readNetwork",
  "back",
  "forward",
  "reload",
  "stop",
  "getPage",
  "listPages",
  "activatePage",
  "closePage",
  "createPage",
  "drag",
  "handleDialog",
  "setFiles",
  "downloads",
  "waitForText",
  "waitForSelector",
  "waitForNetworkIdle",
  "waitForLoad",
  "screenshot",
  "setZoom",
  "find",
  "findClear",
  "pdf",
  "emulate",
  "setStorage",
  "clearStorage",
  "detectLoginForms",
  "listExtensions",
  "openExtension",
  "finalizeTabs",
  "cancelDownload",
  "deleteDownload",
  "saveDownload",
] as const satisfies ReadonlyArray<keyof BrowserEngine>

// Compile-time exhaustiveness: a method added to `BrowserEngine` must be
// placed either in the facade list or in the privileged list.
type UnclassifiedEngineMember = Exclude<
  keyof BrowserEngine,
  | (typeof FACADE_METHODS)[number]
  | PrivilegedBrowserEngineMethod
  | "evaluate"
  | "backend"
  | "credentialFilled"
>
const engineMembersClassified: [UnclassifiedEngineMember] extends [never] ? true : never = true
void engineMembersClassified

const facades = new WeakMap<BrowserEngine, PluginBrowserEngine>()

/**
 * A frozen engine facade for a plugin other than the first-party Browser Tools:
 * no privileged methods, no prototype to reach the engine through, and an
 * `evaluate` that cannot claim a person's post-fill approval.
 */
export function createPluginBrowserEngineFacade(engine: BrowserEngine): PluginBrowserEngine {
  const cached = facades.get(engine)
  if (cached) return cached
  const facade: Record<string, unknown> = Object.create(null)
  for (const method of FACADE_METHODS) {
    facade[method] = (...args: unknown[]) =>
      (engine[method] as (...a: unknown[]) => unknown).apply(engine, args)
  }
  facade.evaluate = (expression: string) => engine.evaluate(String(expression))
  Object.defineProperty(facade, "backend", { enumerable: true, get: () => engine.backend })
  Object.defineProperty(facade, "credentialFilled", {
    enumerable: true,
    get: () => engine.credentialFilled === true,
  })
  const frozen = Object.freeze(facade) as unknown as PluginBrowserEngine
  facades.set(engine, frozen)
  return frozen
}

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

export interface CreateBrowserAPIOptions {
  /**
   * The caller is the first-party Browser Tools plugin
   * ({@link isFirstPartyBrowserPlugin}): hand out the full engine. Every other
   * plugin receives {@link createPluginBrowserEngineFacade}.
   */
  firstParty?: boolean
}

/** Host-owned browser router, consent snapshot, pane requests and annotation persistence. */
export function createBrowserAPI(options: CreateBrowserAPIOptions = {}): PluginBrowserAPI {
  const expose = (engine: BrowserEngine): PluginBrowserEngine =>
    options.firstParty === true ? engine : createPluginBrowserEngineFacade(engine)
  return {
    routeEngine: (url, context) => {
      const route = routeEngine(url, context)
      return { ...route, engine: expose(route.engine) }
    },
    isDomainAuthorized: isBrowserDomainAuthorized,
    primeDomainGrants: primeBrowserDomainGrants,
    saveAnnotation: saveBrowserAnnotation,
    primeLocalRouting: primeLocalBrowserRouting,
    ensureLocalEngine: async (backend, localOptions) =>
      expose(await ensureAgentLocalEngine(backend, localOptions)),
    openPane: (url, paneOptions = {}) =>
      requestBrowserUrl(url, {
        ...(paneOptions.backend ? { backend: paneOptions.backend } : {}),
        ...(paneOptions.chatSessionId ? { chatSessionId: paneOptions.chatSessionId } : {}),
        source: "agent",
      }),
    attachDownload: requestBrowserDownloadAttach,
    isSurfaceVisible: isBrowserSurfaceVisible,
  }
}
