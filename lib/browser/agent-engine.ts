/**
 * Agent-facing browser engine abstraction (ADR-0055). Four engines sit behind
 * one router (ADR-0201): the embedded webview, the desktop's local Chromium
 * and the user's own Chrome (both the workspace-runtime service on loopback),
 * and the cloud WorkspaceRuntime Chromium (ADR-0085). The TARGET URL's trust
 * tier (`resolveTrustTier`) decides routing and whether page content must be
 * treated as untrusted.
 */
import type { Screenshot } from "@/lib/automation/types"
import { emitAgentActivity } from "@/lib/browser/agent-activity"
import { browserClient } from "@/lib/browser/client"
import { bestLocalDesktopBackend } from "@/lib/browser/backend-availability"
import {
  embeddedDownloadToSummary,
  EMBEDDED_DOWNLOAD_EVENT,
  type EmbeddedDownloadEvent,
} from "@/lib/browser/downloads-client"
import type { BrowserExtension } from "@/lib/browser/extensions-client"
import { isUserChromeBrowser, localBrowser } from "@/lib/browser/local-client"
import { extensionBindingFor, extensionEngineFor } from "@/lib/browser/extension-engine"
import { LocalChromiumEngine, type LocalEngineBackend } from "@/lib/browser/local-chromium-engine"
import { fillCredential } from "@/lib/browser/passwords"
import {
  chatPageOwner,
  ensureSharedLocalBrowser,
  ownedPageEngine,
  sharedLocalBrowserStore,
} from "@/lib/browser/shared-local-browser"
import { getActivePaneRect } from "@/lib/browser/pane-rect"
import { SnapshotCache } from "@/lib/browser/snapshot-cache"
import { isTauri, transport } from "@/lib/tauri"
import { onTauriEvent } from "@/lib/tauri/events"
import {
  BrowserSessionError,
  type BrowserPageSummary,
  type BrowserDownloadSummary,
} from "@/lib/browser/session-types"
import { detectHostProfile, type HostProfile } from "@/lib/platform/capabilities"
import {
  BROWSER_EVENTS,
  credentialFilledEvaluateRefusal,
  resolveTrustTier,
  type BrowserActionResult,
  type BrowserSnapshotDirty,
  type EvaluateResult,
  type SnapshotOptions,
  type TrustTier,
} from "@/lib/browser/protocol"
import type {
  BrowserCookieMeta,
  BrowserCredentialFillArgs,
  BrowserCredentialFillResult,
  BrowserEmulateOptions,
  BrowserEmulateResult,
  BrowserEngine,
  BrowserEngineBackend,
  BrowserLoginForm,
  BrowserMutationResult,
  BrowserNetworkRequestDetail,
  BrowserPdfOptions,
  BrowserPdfResult,
  BrowserStorageArea,
  BrowserStorageResult,
  EngineBackendPreference,
  EvaluateOptions,
  FindOptions,
  HandleDialogArgs,
  NetworkIdleOptions,
  ScreenshotOptions,
  ScrollArgs,
  WaitForLoadOptions,
  WaitForOptions,
  WaitForResult,
} from "@cognia/plugin-contract/lib/browser/agent-engine"
export type {
  BrowserCookieMeta,
  BrowserCredentialFillArgs,
  BrowserCredentialFillResult,
  BrowserEmulateOptions,
  BrowserEmulateResult,
  BrowserEngine,
  BrowserEngineBackend,
  BrowserLoginForm,
  BrowserMutationResult,
  BrowserNetworkRequestDetail,
  BrowserPdfOptions,
  BrowserPdfResult,
  BrowserStorageArea,
  BrowserStorageResult,
  BrowserZoomResult,
  EngineBackendPreference,
  EvaluateOptions,
  FindOptions,
  HandleDialogArgs,
  NetworkIdleOptions,
  ScreenshotOptions,
  ScrollArgs,
  WaitForLoadOptions,
  WaitForOptions,
  WaitForResult,
} from "@cognia/plugin-contract/lib/browser/agent-engine"

/** Re-exported: credential-header redaction lives with the wire types. */
export { redactNetworkHeaders } from "@/lib/browser/protocol"

/** Loose URL equality for load-waiting: ignore hash + trailing slash. */
function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => {
    try {
      const p = new URL(u)
      p.hash = ""
      return p.toString().replace(/\/$/, "")
    } catch {
      return u
    }
  }
  return norm(a) === norm(b)
}

/**
 * Poll `check` until it returns the desired truthiness (`appear` → true,
 * `disappear` → false) or the timeout elapses. Shared by the text/selector
 * waits.
 */
async function pollUntil(
  check: () => Promise<boolean>,
  opts: WaitForOptions
): Promise<WaitForResult> {
  const mode = opts.mode ?? "appear"
  const timeoutMs = opts.timeoutMs ?? 5000
  const intervalMs = opts.intervalMs ?? 200
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const has = await check()
    if ((mode === "appear" && has) || (mode === "disappear" && !has)) {
      return { ok: true, timedOut: false }
    }
    if (Date.now() >= deadline) return { ok: false, timedOut: true }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * Process-wide snapshot cache for the single embedded pane (ADR-0127), fed by
 * the overlay's `browser://snapshot` invalidation marker. Module-scoped so
 * every `EmbeddedEngine` instance (the router creates them per call) shares
 * one cache and one listener; `resetEmbeddedSnapshotCache()` is the test seam.
 */
const embeddedSnapshotCache = new SnapshotCache()
let snapshotInvalidationInstalled = false

function installSnapshotInvalidation(): void {
  if (snapshotInvalidationInstalled || !isTauri()) return
  snapshotInvalidationInstalled = true
  void onTauriEvent<BrowserSnapshotDirty>(BROWSER_EVENTS.snapshot, () => {
    embeddedSnapshotCache.markDirty()
  }).catch(() => {
    // No event plane (headless / web): the cache stays conservative — every
    // engine mutation still invalidates it, and `fresh` bypasses it.
    snapshotInvalidationInstalled = false
  })
}

/** Test seam: forget the cached snapshot and its listener registration. */
export function resetEmbeddedSnapshotCache(): void {
  embeddedSnapshotCache.clear()
  snapshotInvalidationInstalled = false
}

/** Test seam: the snapshot cache's hit / miss counters. */
export function embeddedSnapshotCacheStats() {
  return embeddedSnapshotCache.getStats()
}

/**
 * What the embedded webview cannot do, and what can.
 *
 * These are real gaps, not stubs: a single always-on-top child webview has no
 * tabs, no OS drag source, no native dialog channel, no file-chooser hook, no
 * print-to-PDF, no emulation, no cookie jar introspection, no response bodies
 * and no extension runtime, and it can only be captured at its own viewport
 * rect. They are declared once so the refusal a model reads always says *why*
 * and *what enables it* — a bare "not supported" left the model retrying, and
 * left the human with no idea that a setting existed.
 *
 * Per working rule 7 this is the type-level half of that dormancy; the UI half
 * is the disabled control with a stated reason, and the test half pins this
 * list against the methods that throw.
 */
export const EMBEDDED_UNSUPPORTED_FEATURES = {
  createPage: "Creating pages",
  closePage: "Closing the preview's only page",
  drag: "Drag and drop",
  handleDialog: "Native dialogs",
  setFiles: "File upload",
  scopedScreenshot: "Scoped screenshots",
  pdf: "Printing to PDF",
  emulate: "Device and network emulation",
  listCookies: "Listing cookies",
  networkRequest: "Request and response details",
  detectLoginForms: "Login form detection",
  extensions: "Chrome extensions",
  finalizeTabs: "Finalizing agent tabs",
  downloadControl: "Cancelling, deleting or copying downloads",
} as const

export type EmbeddedUnsupportedFeature = keyof typeof EMBEDDED_UNSUPPORTED_FEATURES

/** The refusal text for one of them, including the way out. */
export function embeddedUnsupportedMessage(feature: EmbeddedUnsupportedFeature): string {
  return `${EMBEDDED_UNSUPPORTED_FEATURES[feature]} is not supported by the embedded browser. It is available on the local Chromium backend — install it in Settings → Browser and call browser_open with backend "local-chromium" — or on the cloud browser (Settings → Companion, then grant this domain).`
}

function embeddedUnsupported(feature: EmbeddedUnsupportedFeature): BrowserSessionError {
  return new BrowserSessionError("browser_feature_unsupported", embeddedUnsupportedMessage(feature))
}

/**
 * Downloads the embedded webview reported this app session
 * (`browser://download`, emitted by `src-tauri/src/browser/downloads.rs`).
 * History across restarts is the Downloads panel's Dexie table; this map only
 * answers `browser_downloads` for the agent.
 */
const embeddedDownloads = new Map<string, BrowserDownloadSummary>()
let embeddedDownloadsInstalled = false

function installEmbeddedDownloadFeed(): void {
  if (embeddedDownloadsInstalled || !isTauri()) return
  embeddedDownloadsInstalled = true
  void onTauriEvent<EmbeddedDownloadEvent>(EMBEDDED_DOWNLOAD_EVENT, (event) => {
    if (!event || typeof event.id !== "string") return
    embeddedDownloads.set(
      event.id,
      embeddedDownloadToSummary(event, embeddedDownloads.get(event.id), Date.now())
    )
  }).catch(() => {
    embeddedDownloadsInstalled = false
  })
}

/** Test seam: forget embedded downloads and the listener registration. */
export function resetEmbeddedDownloads(): void {
  embeddedDownloads.clear()
  embeddedDownloadsInstalled = false
}

/** A storage-area expression for the embedded page (`localStorage` / `sessionStorage`). */
function storageObject(area: BrowserStorageArea): string {
  return area === "session" ? "window.sessionStorage" : "window.localStorage"
}

async function evaluateOrThrow(expression: string): Promise<unknown> {
  const result = await browserClient.embedEvaluate(expression)
  if (!result.ok) throw new Error(result.error ?? "Page evaluation failed")
  return result.value
}

/** Drives the in-app embedded webview via the Tauri `browser_embed_*` commands. */
export class EmbeddedEngine implements BrowserEngine {
  readonly backend = "embedded" as const
  private credentialFilledInSession = false
  constructor() {
    installSnapshotInvalidation()
    installEmbeddedDownloadFeed()
  }
  navigate(url: string) {
    emitAgentActivity(`navigate ${url}`)
    embeddedSnapshotCache.markDirty()
    return browserClient.embedNavigate(url)
  }
  recordingControl(action: "start" | "resume" | "stop" | "drain"): Promise<unknown> {
    switch (action) {
      case "start":
        return browserClient.embedStartRecord()
      case "resume":
        return browserClient.embedResumeRecord()
      case "stop":
        return browserClient.embedStopRecord()
      case "drain":
        return browserClient.embedDrainRecord()
    }
  }
  resolveRecordedTarget(selector: string): Promise<string> {
    return browserClient.embedRefFor(selector)
  }
  async snapshot(opts?: SnapshotOptions) {
    // ADR-0127: serve the last walk while nothing invalidated it. Every
    // mutating engine call and every `browser://snapshot` marker marks the
    // cache dirty, so a hit is exactly the tree a fresh walk would produce.
    const cached = embeddedSnapshotCache.get(opts)
    if (cached) return cached
    const { fresh: _fresh, ...walkOpts } = opts ?? {}
    const snapshot = await browserClient.embedSnapshot(walkOpts)
    embeddedSnapshotCache.set(snapshot, opts)
    return snapshot
  }
  act(reference: string, action: string, args: Record<string, unknown>) {
    emitAgentActivity(`${action} ${reference}`)
    embeddedSnapshotCache.markDirty()
    return browserClient.embedAct(reference, action, args)
  }
  pressKey(key: string, reference = "") {
    emitAgentActivity(`key ${key}`)
    embeddedSnapshotCache.markDirty()
    return browserClient.embedAct(reference, "key", { key })
  }
  scroll(args: ScrollArgs) {
    emitAgentActivity(
      args.reference ? `scroll ${args.reference}` : `scroll ${args.direction ?? "down"}`
    )
    // Scrolling changes no DOM (virtualized lists aside — their mutations
    // reach us through the observer marker), so the cache survives it.
    const { reference = "", ...rest } = args
    return browserClient.embedAct(reference, "scroll", rest as Record<string, unknown>)
  }
  /** See {@link BrowserEngine.credentialFilled}. */
  get credentialFilled(): boolean {
    return this.credentialFilledInSession
  }
  /** Test seam / app-session reset: forget that a credential was filled. */
  resetCredentialFilled(): void {
    this.credentialFilledInSession = false
  }
  async evaluate(expr: string, options: EvaluateOptions = {}): Promise<EvaluateResult> {
    if (this.credentialFilledInSession && options.credentialFillApproved !== true) {
      return credentialFilledEvaluateRefusal()
    }
    emitAgentActivity("evaluate")
    embeddedSnapshotCache.markDirty()
    return browserClient.embedEvaluate(expr)
  }
  readConsole() {
    return browserClient.embedReadConsole()
  }
  readNetwork() {
    return browserClient.embedReadNetwork()
  }
  back() {
    emitAgentActivity("back")
    embeddedSnapshotCache.markDirty()
    return browserClient.embedBack()
  }
  forward() {
    emitAgentActivity("forward")
    embeddedSnapshotCache.markDirty()
    return browserClient.embedForward()
  }
  reload() {
    emitAgentActivity("reload")
    embeddedSnapshotCache.markDirty()
    return browserClient.embedReload()
  }
  stop() {
    emitAgentActivity("stop")
    return browserClient.embedStop()
  }
  async getPage() {
    const [url, title] = await Promise.all([
      browserClient.embedGetUrl(),
      browserClient.embedGetTitle(),
    ])
    return { url, title }
  }
  async listPages(): Promise<BrowserPageSummary[]> {
    const page = await this.getPage()
    return [{ id: "embedded", ...page, active: true }]
  }
  async activatePage(pageId: string): Promise<void> {
    if (pageId !== "embedded") {
      throw new BrowserSessionError("browser_page_not_found", "Browser page not found")
    }
  }
  /**
   * The embedded pane has exactly one page and the pane owns it. Closing it
   * used to navigate to `about:blank`, which wiped whatever the user had open
   * and reported success for a page that still existed (ADR-0201).
   */
  async closePage(pageId: string): Promise<void> {
    await this.activatePage(pageId)
    throw embeddedUnsupported("closePage")
  }
  async createPage(_url?: string): Promise<BrowserPageSummary> {
    throw embeddedUnsupported("createPage")
  }
  async drag(_sourceRef: string, _targetRef: string): Promise<BrowserActionResult> {
    throw embeddedUnsupported("drag")
  }
  async handleDialog(_args: HandleDialogArgs): Promise<BrowserActionResult> {
    throw embeddedUnsupported("handleDialog")
  }
  async setFiles(_reference: string, _paths: string[]): Promise<void> {
    throw embeddedUnsupported("setFiles")
  }
  /** Downloads Rust routed into the downloads directory this app session. */
  async downloads(): Promise<BrowserDownloadSummary[]> {
    installEmbeddedDownloadFeed()
    return [...embeddedDownloads.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0))
  }
  waitForText(text: string, opts: WaitForOptions = {}): Promise<WaitForResult> {
    return pollUntil(() => browserClient.embedHasText(text), opts)
  }
  waitForSelector(selector: string, opts: WaitForOptions = {}): Promise<WaitForResult> {
    return pollUntil(() => browserClient.embedHasSelector(selector), opts)
  }
  async waitForNetworkIdle(opts: NetworkIdleOptions = {}): Promise<WaitForResult> {
    const timeoutMs = opts.timeoutMs ?? 10000
    const idleMs = opts.idleMs ?? 500
    const intervalMs = opts.intervalMs ?? 200
    const deadline = Date.now() + timeoutMs
    let lastCompleted: number | null = null
    let stableSince = Date.now()
    for (;;) {
      const st = await browserClient.embedNetworkState()
      const now = Date.now()
      const idle = st.pending === 0 && st.completed === lastCompleted
      if (idle) {
        if (now - stableSince >= idleMs) return { ok: true, timedOut: false }
      } else {
        lastCompleted = st.completed
        stableSince = now
      }
      if (now >= deadline) return { ok: false, timedOut: true }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  /**
   * Poll the page's URL + readyState until the navigation lands: the URL
   * matches `targetUrl` (or has left `fromUrl` — redirects) and the document is
   * `complete`. Eval failures mid-swap count as "not ready yet". Without
   * target/from it degrades to a readyState-complete wait, which is the right
   * shape for reload/back/forward and for settling after a click that may or
   * may not navigate.
   */
  async waitForLoad(opts: WaitForLoadOptions = {}): Promise<WaitForResult> {
    const timeoutMs = opts.timeoutMs ?? 8000
    const intervalMs = opts.intervalMs ?? 150
    if (opts.initialDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, opts.initialDelayMs))
    }
    const deadline = Date.now() + timeoutMs
    for (;;) {
      try {
        const res = await browserClient.embedEvaluate(
          "({url:String(window.location.href),ready:String(document.readyState)})"
        )
        if (res.ok && res.value && typeof res.value === "object") {
          const { url, ready } = res.value as { url?: string; ready?: string }
          const cur = String(url ?? "")
          const arrived = opts.targetUrl
            ? sameUrl(cur, opts.targetUrl) || (opts.fromUrl != null && !sameUrl(cur, opts.fromUrl))
            : opts.fromUrl != null
              ? !sameUrl(cur, opts.fromUrl)
              : true
          if (arrived && ready === "complete") return { ok: true, timedOut: false }
        }
      } catch {
        // Document mid-swap — the eval bridge can reject; keep polling.
      }
      if (Date.now() >= deadline) return { ok: false, timedOut: true }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  screenshot(options: ScreenshotOptions = {}): Promise<Screenshot> {
    if ((options.scope ?? "viewport") !== "viewport" || options.ref) {
      return Promise.reject(
        new BrowserSessionError(
          "browser_feature_unsupported",
          embeddedUnsupportedMessage("scopedScreenshot")
        )
      )
    }
    const rect = getActivePaneRect()
    if (!rect) return Promise.reject(new Error("preview is not open"))
    emitAgentActivity("screenshot")
    return browserClient.embedCapture(rect)
  }
  async setZoom(zoom: number): Promise<{ ok: boolean; zoom: number }> {
    const normalizedZoom = Number.isFinite(zoom) ? Math.min(5, Math.max(0.25, zoom)) : 1
    await browserClient.embedSetZoom(normalizedZoom)
    return { ok: true, zoom: normalizedZoom }
  }
  find(query: string, options?: FindOptions): Promise<{ matches: number; index: number }> {
    return browserClient.embedFind(query, options)
  }
  findClear(): Promise<void> {
    return browserClient.embedFindClear()
  }
  async pdf(_options?: BrowserPdfOptions): Promise<BrowserPdfResult> {
    throw embeddedUnsupported("pdf")
  }
  async emulate(_options: BrowserEmulateOptions): Promise<BrowserEmulateResult> {
    throw embeddedUnsupported("emulate")
  }
  async listCookies(_domain?: string): Promise<BrowserCookieMeta[]> {
    throw embeddedUnsupported("listCookies")
  }
  /**
   * Clear the embedded webview's cookies for one site (its registrable
   * domain), or every public site when no domain is given. Local development
   * hosts and the app's own origin are left alone by Rust.
   */
  async clearCookies(domain?: string): Promise<{ removed: number }> {
    emitAgentActivity(domain ? `clear cookies ${domain}` : "clear cookies")
    embeddedSnapshotCache.markDirty()
    if (domain) {
      const result = await transport.call<{ removed: number }>("browser_cookie_clear", { domain })
      return { removed: result.removed }
    }
    return transport.call<{ removed: number }>("browser_cookie_clear_all", {})
  }
  async getStorage(area: BrowserStorageArea, key?: string): Promise<BrowserStorageResult> {
    const store = storageObject(area)
    const expression =
      key === undefined
        ? `(()=>{const s=${store};const o={};for(let i=0;i<s.length;i++){const k=s.key(i);if(k!==null)o[k]=s.getItem(k)}return {origin:location.origin,entries:o}})()`
        : `({origin:location.origin,exists:${store}.getItem(${JSON.stringify(key)})!==null,entries:{[${JSON.stringify(key)}]:${store}.getItem(${JSON.stringify(key)})}})`
    const value = (await evaluateOrThrow(expression)) as {
      origin?: string
      exists?: boolean
      entries?: Record<string, string | null>
    } | null
    return {
      area,
      origin: value?.origin,
      entries: value?.entries ?? {},
      ...(key !== undefined && typeof value?.exists === "boolean" ? { exists: value.exists } : {}),
    }
  }
  async setStorage(
    area: BrowserStorageArea,
    key: string,
    value: string
  ): Promise<BrowserMutationResult> {
    emitAgentActivity(`storage set ${key}`)
    embeddedSnapshotCache.markDirty()
    await evaluateOrThrow(
      `(${storageObject(area)}.setItem(${JSON.stringify(key)},${JSON.stringify(value)}),true)`
    )
    return { ok: true }
  }
  async clearStorage(area: BrowserStorageArea): Promise<BrowserMutationResult> {
    emitAgentActivity(`storage clear ${area}`)
    embeddedSnapshotCache.markDirty()
    await evaluateOrThrow(`(${storageObject(area)}.clear(),true)`)
    return { ok: true }
  }
  async networkRequest(_requestId: string): Promise<BrowserNetworkRequestDetail> {
    throw embeddedUnsupported("networkRequest")
  }
  async detectLoginForms(_pageId?: string): Promise<BrowserLoginForm[]> {
    throw embeddedUnsupported("detectLoginForms")
  }
  async fillCredential(args: BrowserCredentialFillArgs): Promise<BrowserCredentialFillResult> {
    emitAgentActivity("fill credential")
    embeddedSnapshotCache.markDirty()
    const url = args.url ?? (await browserClient.embedGetUrl())
    const result = await fillCredential({
      target: "embedded",
      credentialId: args.credentialId ?? null,
      url,
    })
    if (result.filled === true) this.credentialFilledInSession = true
    return {
      filled: result.filled === true,
      username: result.username ?? null,
      reason: result.reason ?? null,
    }
  }
  async listExtensions(): Promise<BrowserExtension[]> {
    throw embeddedUnsupported("extensions")
  }
  async openExtension(
    _extensionId: string,
    _page: "popup" | "options"
  ): Promise<BrowserPageSummary | BrowserActionResult> {
    throw embeddedUnsupported("extensions")
  }
  async finalizeTabs(): Promise<{ closed: number }> {
    throw embeddedUnsupported("finalizeTabs")
  }
  async cancelDownload(_downloadId: string): Promise<BrowserDownloadSummary> {
    throw embeddedUnsupported("downloadControl")
  }
  async deleteDownload(_downloadId: string): Promise<{ deleted: boolean; id: string }> {
    throw embeddedUnsupported("downloadControl")
  }
  async saveDownload(_downloadId: string, _targetPath: string): Promise<BrowserDownloadSummary> {
    throw embeddedUnsupported("downloadControl")
  }
}

const embedded = new EmbeddedEngine()

export interface EngineRoute {
  engine: BrowserEngine
  backend: BrowserEngineBackend
  tier: TrustTier
  /** Page content must be treated as untrusted (public origin). */
  untrusted: boolean
}

export interface EngineRoutingContext {
  hostProfile?: HostProfile
  backendPreference?: EngineBackendPreference
  remoteEnabled?: boolean
  remoteHealthy?: boolean
  domainAuthorized?: boolean
  /** Override the primed "local Chromium is installed" snapshot. */
  localChromiumInstalled?: boolean
  /**
   * The conversation the call is for (ADR-0214). On local Chromium every
   * conversation drives its own page in the shared session; without one the
   * call is the focused conversation's.
   */
  chatSessionId?: string
}

let remoteEngine: BrowserEngine | null = null
let remoteReadiness = { enabled: false, healthy: false }

/** Install the per-chat remote adapter after BrowserSession ensure succeeds. */
export function configureRemoteBrowserEngine(
  engine: BrowserEngine | null,
  readiness: { enabled: boolean; healthy: boolean } = { enabled: false, healthy: false }
): void {
  remoteEngine = engine
  remoteReadiness = readiness
}

// ── Desktop local runtime (ADR-0201, ADR-0214) ──────────────────────────────

/**
 * The user's Chrome a browser pane is showing (`user-chrome` only). While
 * bound, the agent drives exactly that session — the user chose it.
 *
 * Cognia's own Chromium has no such binding any more: every local-Chromium
 * page lives in the one shared session (`shared-local-browser.ts`) and belongs
 * to a conversation, so the agent drives its conversation's page whatever pane
 * is on screen.
 */
let paneLocalEngine: LocalChromiumEngine | null = null
/** A user-chrome session the router created itself because no pane was bound. */
let agentLocalEngine: LocalChromiumEngine | null = null
let localChromiumInstalled = false

/** Window event a pane listens to so it can show a router-created user-chrome session. */
export const BROWSER_AGENT_LOCAL_SESSION_EVENT = "cognia:browser:agent-local-session"

export interface BrowserAgentLocalSession {
  sessionId: string
  backend: LocalEngineBackend
}

/**
 * The browser pane binds (or, with `null`, unbinds) the user-chrome session it
 * is showing. A `local-chromium` session is not bound: it is the shared one,
 * and binding it would make every conversation's agent drive one page.
 */
export function configureLocalBrowserEngine(session: BrowserAgentLocalSession | null): void {
  if (!session) {
    paneLocalEngine = null
    return
  }
  if (session.backend === "local-chromium") {
    localChromiumInstalled = true
    return
  }
  if (agentLocalEngine?.sessionId === session.sessionId) agentLocalEngine = null
  paneLocalEngine = new LocalChromiumEngine(session.sessionId, session.backend)
}

/** Record whether the managed Chromium is installed (the pane / status poll feed this). */
export function setLocalChromiumInstalled(installed: boolean): void {
  localChromiumInstalled = installed
}

/** The last known install state of the managed Chromium (see `primeLocalBrowserRouting`). */
export function isLocalChromiumInstalled(): boolean {
  return localChromiumInstalled
}

/**
 * Warm the routing snapshots `routeEngine` reads synchronously: the local
 * Chromium install state. Safe to call repeatedly; a failed status read keeps
 * the last known value.
 */
export async function primeLocalBrowserRouting(): Promise<void> {
  if (!isTauri()) return
  try {
    const status = await localBrowser.status()
    setLocalChromiumInstalled(status.installed)
  } catch {
    // No runtime command (older shell / web): keep the last known value.
  }
}

/**
 * Which conversation is on screen, for a caller that names none or names one
 * the dock does not show (an External Bridge client). Wired by
 * `DockPagesLifecycleInitializer`; unwired, such calls get pages of their own
 * that no dock shows.
 */
let activeChatSessionId: () => string | null = () => null
/** External clients pinned to the conversation that was on screen at their first call. */
const foreignOwners = new Map<string, string>()

export function configureAgentPageOwnership(
  options: {
    activeChatSessionId: () => string | null
  } | null
): void {
  activeChatSessionId = options?.activeChatSessionId ?? (() => null)
  foreignOwners.clear()
}

/** External Bridge clients bind their calls to a synthetic conversation id. */
const FOREIGN_CHAT_PREFIX = "external-bridge:"

/**
 * The owner whose pages an agent call drives. A conversation drives its own;
 * an External Bridge client drives pages shown in the conversation that was on
 * screen when it first reached for the browser — its pages then appear as tabs
 * there and follow that task — and keeps that conversation afterwards.
 */
export function agentPageOwner(chatSessionId: string | undefined): string {
  if (chatSessionId && !chatSessionId.startsWith(FOREIGN_CHAT_PREFIX)) {
    return chatPageOwner(chatSessionId)
  }
  const key = chatSessionId ?? "default"
  const pinned = foreignOwners.get(key)
  if (pinned) return pinned
  const active = activeChatSessionId()
  if (!chatSessionId) return active ? chatPageOwner(active) : "agent:default"
  const owner = active ? chatPageOwner(active) : `agent:${chatSessionId}`
  foreignOwners.set(key, owner)
  return owner
}

/** Test seam: forget every local binding. */
export function resetLocalBrowserRouting(): void {
  paneLocalEngine = null
  agentLocalEngine = null
  localChromiumInstalled = false
  lazyLocalPending = null
  foreignOwners.clear()
  activeChatSessionId = () => null
}

let lazyLocalPending: Promise<LocalChromiumEngine> | null = null

function announceAgentLocalSession(session: BrowserAgentLocalSession): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return
  window.dispatchEvent(
    new CustomEvent<BrowserAgentLocalSession>(BROWSER_AGENT_LOCAL_SESSION_EVENT, {
      detail: session,
    })
  )
}

/**
 * The agent's engine on a desktop backend.
 *
 * - `local-chromium`: the conversation's own page in the shared session
 *   (`ownedPageEngine`), the session created on first use.
 * - `user-chrome`: the pane's session when one is bound, else a headless
 *   session of the router's own, announced so a pane can show it.
 */
export async function ensureAgentLocalEngine(
  backend: LocalEngineBackend = "local-chromium",
  options: { headless?: boolean; browser?: string; chatSessionId?: string } = {}
): Promise<BrowserEngine> {
  // Plugins name the browser as a free string; refuse one Rust does not know
  // rather than let it fall back to Chrome silently.
  const browser = backend === "user-chrome" ? options.browser : undefined
  if (browser !== undefined && !isUserChromeBrowser(browser)) {
    throw new BrowserSessionError(
      "browser_feature_unsupported",
      `Unknown browser "${browser}" for user-chrome`
    )
  }
  if (backend === "local-chromium") {
    await ensureSharedLocalBrowser()
    localChromiumInstalled = true
    return ownedPageEngine(agentPageOwner(options.chatSessionId))
  }
  if (paneLocalEngine) return paneLocalEngine
  if (agentLocalEngine) return agentLocalEngine
  if (lazyLocalPending) return lazyLocalPending
  const sessionId = `agent-${backend}-${Math.random().toString(36).slice(2, 10)}`
  lazyLocalPending = localBrowser
    .createSession({
      id: sessionId,
      kind: "user-chrome",
      headless: options.headless ?? true,
      ...(browser ? { browser } : {}),
    })
    .then((created) => {
      const engine = new LocalChromiumEngine(created?.id ?? sessionId, backend)
      agentLocalEngine = engine
      announceAgentLocalSession({ sessionId: engine.sessionId, backend })
      return engine
    })
  try {
    return await lazyLocalPending
  } finally {
    lazyLocalPending = null
  }
}

/**
 * A `BrowserEngine` whose first call creates the router's user-chrome
 * session. `routeEngine` is synchronous; session creation is not — this
 * bridges them without making every caller async.
 */
function lazyUserChromeEngine(): BrowserEngine {
  const ready = () => ensureAgentLocalEngine("user-chrome")
  return new Proxy({ backend: "user-chrome" } as BrowserEngine, {
    get(target, property) {
      if (property === "backend") return "user-chrome"
      if (property === "then") return undefined
      // A data property, not a method: report the session's post-fill lock
      // once the session exists (none yet means nothing was filled).
      if (property === "credentialFilled") return agentLocalEngine?.credentialFilled ?? false
      return (...args: unknown[]) =>
        ready().then((engine) => {
          const method = (engine as unknown as Record<PropertyKey, unknown>)[property]
          if (typeof method !== "function") {
            throw new TypeError(`BrowserEngine has no method ${String(property)}`)
          }
          return (method as (...a: unknown[]) => unknown).apply(engine, args)
        })
    },
  })
}

function userChromeRoute(tier: TrustTier): EngineRoute {
  const engine = paneLocalEngine ?? agentLocalEngine ?? lazyUserChromeEngine()
  return { engine, backend: "user-chrome", tier, untrusted: tier === "public" }
}

function extensionRoute(tier: TrustTier, chatSessionId: string | undefined): EngineRoute {
  return {
    engine: extensionEngineFor(chatSessionId),
    backend: "extension",
    tier,
    untrusted: tier === "public",
  }
}

function localChromiumRoute(tier: TrustTier, chatSessionId: string | undefined): EngineRoute {
  return {
    engine: ownedPageEngine(agentPageOwner(chatSessionId)),
    backend: "local-chromium",
    tier,
    untrusted: tier === "public",
  }
}

/**
 * Resolve the engine for a TARGET URL (ADR-0201, ADR-0214). Callers pass the
 * URL the next call will act on — for a navigation that is the destination,
 * not the page being left.
 *
 * - Cloud / mobile / headless hosts use the bound remote engine.
 * - An explicit preference is honoured, or refused with the reason.
 * - A pane showing the user's own Chrome keeps the agent on that session.
 * - A public URL the user authorized goes to the cloud browser when it is
 *   ready.
 * - Otherwise local Chromium once installed — localhost included, so dev
 *   servers get DevTools extensions and real tabs — on the conversation's own
 *   page; the embedded webview before that.
 *
 * Active sessions never migrate implicitly between remote and local backends.
 */
export function routeEngine(url: string, context: EngineRoutingContext = {}): EngineRoute {
  const tier = resolveTrustTier(url)
  const untrusted = tier === "public"
  const preference = context.backendPreference ?? "auto"
  const remoteReady =
    !!remoteEngine &&
    (context.remoteEnabled ?? remoteReadiness.enabled) &&
    (context.remoteHealthy ?? remoteReadiness.healthy)
  const profile = context.hostProfile ?? (remoteEngine ? detectHostProfile() : "desktop")
  const installed = context.localChromiumInstalled ?? localChromiumInstalled
  const remoteRoute = (): EngineRoute => {
    if (!remoteReady || !remoteEngine) {
      throw new BrowserSessionError(
        "browser_feature_unsupported",
        "Remote browser is not enabled or healthy"
      )
    }
    return { engine: remoteEngine, backend: "remote-chromium", tier, untrusted }
  }
  const embeddedRoute = (): EngineRoute => ({
    engine: embedded,
    backend: "embedded",
    tier,
    untrusted,
  })

  switch (preference) {
    case "remote-chromium":
      return remoteRoute()
    case "embedded":
      return embeddedRoute()
    case "local-chromium":
      if (!installed && sharedLocalBrowserStore.getState().status !== "ready") {
        throw new BrowserSessionError(
          "browser_feature_unsupported",
          "Local Chromium is not installed. Install it in Settings → Browser."
        )
      }
      return localChromiumRoute(tier, context.chatSessionId)
    case "user-chrome":
      if (paneLocalEngine || agentLocalEngine) return userChromeRoute(tier)
      throw new BrowserSessionError(
        "browser_feature_unsupported",
        "No session is attached to your Chrome. Open the browser pane, choose “Your Chrome”, and allow the connection in Chrome."
      )
    case "extension":
      // Refuses, with the remedy, when the conversation is not bound to a
      // paired browser.
      return extensionRoute(tier, context.chatSessionId)
    case "auto":
    default:
      break
  }

  // A conversation the user started from the extension's "let Cognia act in
  // this browser" acts there, whatever the URL: that is what they asked for.
  // Checked before the host profile: a headless Host serves the extension's
  // device socket too, and only a Host ever binds a conversation to a browser.
  if (extensionBindingFor(context.chatSessionId)) {
    return extensionRoute(tier, context.chatSessionId)
  }
  if (profile === "cloud-companion" || profile === "mobile-companion" || profile === "headless") {
    return remoteRoute()
  }
  // The user chose their own Chrome in the pane: drive what they see.
  if (paneLocalEngine) return userChromeRoute(tier)
  if (untrusted && context.domainAuthorized === true && remoteReady) return remoteRoute()
  if (agentLocalEngine) return userChromeRoute(tier)
  // `profile` is the desktop here, so the shell half of the check holds.
  return bestLocalDesktopBackend({ tauri: true, localChromiumInstalled: installed }) ===
    "local-chromium"
    ? localChromiumRoute(tier, context.chatSessionId)
    : embeddedRoute()
}
