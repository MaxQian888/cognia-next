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
import { localBrowser } from "@/lib/browser/local-client"
import { LocalChromiumEngine, type LocalEngineBackend } from "@/lib/browser/local-chromium-engine"
import { fillCredential, type CredentialFillReason } from "@/lib/browser/passwords"
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
  type BrowserDialogState,
  type BrowserSnapshot,
  type BrowserSnapshotDirty,
  type ConsoleEntry,
  type EvaluateResult,
  type NetworkEntry,
  type SnapshotOptions,
  type TrustTier,
} from "@/lib/browser/protocol"

export interface BrowserEngine {
  navigate(url: string): Promise<void | BrowserMutationResult>
  snapshot(opts?: SnapshotOptions): Promise<BrowserSnapshot>
  act(
    reference: string,
    action: string,
    args: Record<string, unknown>
  ): Promise<BrowserActionResult>
  /** Press a key chord (Enter, Tab, ctrl+a, …); ref optional (focused element). */
  pressKey(key: string, reference?: string): Promise<BrowserActionResult>
  /** Scroll an element into view (ref) or the page (direction/amount). */
  scroll(args: ScrollArgs): Promise<BrowserActionResult>
  /**
   * Evaluate a JS expression in the page (trust-gated by the caller). Once
   * {@link BrowserEngine.credentialFilled} is set the engine refuses with
   * `browser_human_input_required` unless the caller passes
   * `credentialFillApproved` for a person's per-call approval of THIS
   * expression (ADR-0201).
   */
  evaluate(expr: string, options?: EvaluateOptions): Promise<EvaluateResult>
  readConsole(): Promise<ConsoleEntry[]>
  readNetwork(): Promise<NetworkEntry[]>
  back(): Promise<void | BrowserMutationResult>
  forward(): Promise<void | BrowserMutationResult>
  reload(): Promise<void | BrowserMutationResult>
  stop(): Promise<void | BrowserMutationResult>
  getPage(): Promise<{ url: string; title: string }>
  listPages(): Promise<BrowserPageSummary[]>
  activatePage(pageId: string): Promise<void>
  closePage(pageId: string): Promise<void>
  createPage(url?: string): Promise<BrowserPageSummary | BrowserActionResult>
  drag(sourceRef: string, targetRef: string): Promise<BrowserActionResult>
  handleDialog(args: HandleDialogArgs): Promise<BrowserActionResult>
  setFiles(reference: string, paths: string[]): Promise<void | BrowserMutationResult>
  downloads(): Promise<BrowserDownloadSummary[]>
  waitForText(text: string, opts?: WaitForOptions): Promise<WaitForResult>
  waitForSelector(selector: string, opts?: WaitForOptions): Promise<WaitForResult>
  waitForNetworkIdle(opts?: NetworkIdleOptions): Promise<WaitForResult>
  /** Wait for a just-triggered navigation to land (document loaded). */
  waitForLoad(opts?: WaitForLoadOptions): Promise<WaitForResult>
  screenshot(options?: ScreenshotOptions): Promise<Screenshot>
  setZoom(zoom: number): Promise<BrowserZoomResult>
  find(query: string, options?: FindOptions): Promise<{ matches: number; index: number }>
  findClear(): Promise<void>

  // ── ADR-0201 ─────────────────────────────────────────────────────────────
  /** Which backend this engine drives. */
  readonly backend: BrowserEngineBackend
  /** Print the active page to a PDF in the downloads directory. */
  pdf(options?: BrowserPdfOptions): Promise<BrowserPdfResult>
  /** Device / viewport / locale / network emulation for the session. */
  emulate(options: BrowserEmulateOptions): Promise<BrowserEmulateResult>
  /** Cookie METADATA (never values), optionally for one domain. */
  listCookies(domain?: string): Promise<BrowserCookieMeta[]>
  clearCookies(domain?: string): Promise<{ removed: number }>
  getStorage(area: BrowserStorageArea, key?: string): Promise<BrowserStorageResult>
  setStorage(area: BrowserStorageArea, key: string, value: string): Promise<BrowserMutationResult>
  clearStorage(area: BrowserStorageArea): Promise<BrowserMutationResult>
  /** One request's headers and truncated body; auth headers redacted by the runtime. */
  networkRequest(requestId: string): Promise<BrowserNetworkRequestDetail>
  detectLoginForms(pageId?: string): Promise<BrowserLoginForm[]>
  /**
   * Rust fills the password; only `{filled, username}` comes back. A
   * successful fill sets {@link BrowserEngine.credentialFilled}.
   */
  fillCredential(args: BrowserCredentialFillArgs): Promise<BrowserCredentialFillResult>
  /**
   * True once a vault credential was filled in this engine's session: the page
   * may hold a password, so `evaluate` needs per-call approval. Absent on
   * engines that cannot fill credentials (the cloud engine).
   */
  readonly credentialFilled?: boolean
  listExtensions(): Promise<BrowserExtension[]>
  openExtension(
    extensionId: string,
    page: "popup" | "options"
  ): Promise<BrowserPageSummary | BrowserActionResult>
  /** `user-chrome`: close the tabs this session opened, leave the user's alone. */
  finalizeTabs(): Promise<{ closed: number }>
  cancelDownload(downloadId: string): Promise<BrowserDownloadSummary>
  deleteDownload(downloadId: string): Promise<{ deleted: boolean; id: string }>
  /**
   * Copy a finished download. Local Chromium / user Chrome ignore
   * `targetPath`: the user picks the destination in a native save dialog.
   */
  saveDownload(downloadId: string, targetPath?: string): Promise<BrowserDownloadSummary>
}

/** Options for {@link BrowserEngine.evaluate}. */
export interface EvaluateOptions {
  /**
   * A person approved this exact expression for this one call, after a vault
   * credential was filled. Only the first-party browser tools set it, and only
   * after their own confirmation dialog; the plugin engine facade drops it.
   */
  credentialFillApproved?: boolean
}

/** The engine-level backend names (the router's `EngineRoute.backend`). */
export type BrowserEngineBackend = "embedded" | "local-chromium" | "user-chrome" | "remote-chromium"

export interface BrowserPdfOptions {
  /** Page to print; defaults to the active page. */
  pageId?: string
  landscape?: boolean
  /** Default true. */
  printBackground?: boolean
  preferCSSPageSize?: boolean
  /** 0.1–2. */
  scale?: number
  /** Inches, ≤ 100. */
  paperWidth?: number
  paperHeight?: number
  /** Inches, ≤ 20. */
  marginTop?: number
  marginBottom?: number
  marginLeft?: number
  marginRight?: number
  /** e.g. `"1-3, 5"`. */
  pageRanges?: string
  /** File name in the downloads directory (`.pdf` appended when missing). */
  filename?: string
}

export interface BrowserPdfResult {
  /** Absolute path in the downloads directory (desktop runtime). */
  path?: string
  download?: BrowserDownloadSummary
}

export interface BrowserEmulateOptions {
  pageId?: string
  /** Drop every override on the page. */
  reset?: boolean
  /** A Playwright device descriptor name (`iPhone 15`, `Pixel 7`, …). */
  device?: string
  viewport?: { width: number; height: number; deviceScaleFactor?: number }
  userAgent?: string
  colorScheme?: "light" | "dark" | "no-preference"
  locale?: string
  timezone?: string
  /** `null` clears a previous override. */
  geolocation?: { latitude: number; longitude: number; accuracy?: number } | null
  offline?: boolean
}

export interface BrowserEmulateResult extends BrowserMutationResult {
  /** Which overrides took effect (`viewport`, `userAgent`, `offline`, `reset`, …). */
  applied?: string[]
}

export interface BrowserCookieMeta {
  name: string
  domain: string
  path: string
  /** Epoch seconds; null for a session cookie. */
  expires: number | null
  secure: boolean
  httpOnly: boolean
  sameSite?: string
  /** Value length in bytes — the value itself never leaves the runtime. */
  size?: number
}

export type BrowserStorageArea = "local" | "session"

export interface BrowserStorageResult {
  area: BrowserStorageArea
  origin?: string
  /**
   * All entries (no `key`) or the one asked for. A `null` value is a real
   * "absent" only when `valuesWithheld` is not set; see `exists` for a
   * single-key read.
   */
  entries: Record<string, string | null>
  /**
   * The runtime withheld the values (a non-loopback origin on local
   * Chromium): every value is `null` and says nothing about the real one.
   */
  valuesWithheld?: boolean
  /** Single-key read: whether the key exists, reported even when its value is withheld. */
  exists?: boolean
}

export interface BrowserNetworkRequestDetail {
  id?: string
  url: string
  method: string
  status: number | null
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
  /** UTF-8 text, or base64 when `bodyEncoding` says so; null when withheld. */
  body: string | null
  bodyEncoding?: "utf8" | "base64" | null
  truncated: boolean
  bodyBytes?: number
  /** True after human keyboard input or a credential fill: bodies are withheld. */
  bodyRedacted?: boolean
}

export interface BrowserLoginForm {
  ref: string
  usernameRef?: string
  passwordRef: string
  origin: string
}

export interface BrowserCredentialFillArgs {
  /** A vault credential id; omitted → the unique registrable-domain match. */
  credentialId?: string
  pageId?: string
  /** The page URL to match against; defaults to the live page. */
  url?: string
}

export interface BrowserCredentialFillResult {
  filled: boolean
  username: string | null
  reason: CredentialFillReason | null
}

/** Re-exported: credential-header redaction lives with the wire types. */
export { redactNetworkHeaders } from "@/lib/browser/protocol"

export interface BrowserMutationResult extends BrowserDialogState {
  ok: boolean
  error?: string | null
  generation?: number
}

export interface BrowserZoomResult extends BrowserMutationResult {
  zoom?: number
}

export interface HandleDialogArgs {
  accept: boolean
  promptText?: string
}

export interface FindOptions {
  forward?: boolean
  matchCase?: boolean
}

export interface ScreenshotOptions {
  scope?: "viewport" | "fullPage" | "element"
  ref?: string
}

export interface ScrollArgs {
  reference?: string
  direction?: "up" | "down" | "left" | "right" | "top" | "bottom"
  amount?: number
}

export interface WaitForOptions {
  /** Wait for the condition to be met (default) or to clear. */
  mode?: "appear" | "disappear"
  timeoutMs?: number
  intervalMs?: number
}

export interface NetworkIdleOptions {
  timeoutMs?: number
  /** How long the network must stay quiet (no in-flight + no completions). */
  idleMs?: number
  intervalMs?: number
}

export interface WaitForResult {
  ok: boolean
  timedOut: boolean
}

export interface WaitForLoadOptions {
  /** URL the navigation should land on (redirects may change it — see fromUrl). */
  targetUrl?: string
  /** URL before the navigation; leaving it also counts as "arrived". */
  fromUrl?: string
  timeoutMs?: number
  intervalMs?: number
  /** Delay before the first poll (lets a same-URL reload actually start). */
  initialDelayMs?: number
}

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

export type EngineBackendPreference =
  "auto" | "embedded" | "remote-chromium" | "local-chromium" | "user-chrome"

export interface EngineRoutingContext {
  hostProfile?: HostProfile
  backendPreference?: EngineBackendPreference
  remoteEnabled?: boolean
  remoteHealthy?: boolean
  domainAuthorized?: boolean
  /** Override the primed "local Chromium is installed" snapshot. */
  localChromiumInstalled?: boolean
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

// ── Desktop local runtime (ADR-0201) ─────────────────────────────────────────

/** The session the browser pane is showing, when it shows a local backend. */
let paneLocalEngine: LocalChromiumEngine | null = null
/** A session the router created itself because no pane session was bound. */
let agentLocalEngine: LocalChromiumEngine | null = null
let localChromiumInstalled = false

/** Window event the pane listens to so it can show a router-created session. */
export const BROWSER_AGENT_LOCAL_SESSION_EVENT = "cognia:browser:agent-local-session"

export interface BrowserAgentLocalSession {
  sessionId: string
  backend: LocalEngineBackend
}

/**
 * The browser pane binds (or, with `null`, unbinds) the local runtime session
 * it is showing. While bound, the agent drives exactly that session — the page
 * the user sees — for every URL, because the user chose that backend.
 */
export function configureLocalBrowserEngine(session: BrowserAgentLocalSession | null): void {
  if (!session) {
    paneLocalEngine = null
    return
  }
  if (session.backend === "local-chromium") localChromiumInstalled = true
  if (agentLocalEngine?.sessionId === session.sessionId) agentLocalEngine = null
  paneLocalEngine = new LocalChromiumEngine(session.sessionId, session.backend)
}

/** Record whether the managed Chromium is installed (the pane / status poll feed this). */
export function setLocalChromiumInstalled(installed: boolean): void {
  localChromiumInstalled = installed
  if (!installed) agentLocalEngine = null
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

/** Test seam: forget every local binding. */
export function resetLocalBrowserRouting(): void {
  paneLocalEngine = null
  agentLocalEngine = null
  localChromiumInstalled = false
  lazyLocalPending = null
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
 * Create (once) the router's own local Chromium session. Headless: no
 * Chromium window pops up; the pane can still show it through the screencast
 * once it adopts the session announced on `BROWSER_AGENT_LOCAL_SESSION_EVENT`.
 */
export async function ensureAgentLocalEngine(
  backend: LocalEngineBackend = "local-chromium",
  options: { headless?: boolean; browser?: string } = {}
): Promise<LocalChromiumEngine> {
  if (paneLocalEngine && paneLocalEngine.backend === backend) return paneLocalEngine
  if (agentLocalEngine && agentLocalEngine.backend === backend) return agentLocalEngine
  if (lazyLocalPending) {
    const pending = await lazyLocalPending
    if (pending.backend === backend) return pending
  }
  const sessionId = `agent-${backend}-${Math.random().toString(36).slice(2, 10)}`
  lazyLocalPending = localBrowser
    .createSession({
      id: sessionId,
      kind: backend === "user-chrome" ? "user-chrome" : "local",
      headless: options.headless ?? true,
      ...(backend === "user-chrome" && options.browser
        ? { browser: options.browser as never }
        : {}),
    })
    .then((created) => {
      const engine = new LocalChromiumEngine(created?.id ?? sessionId, backend)
      agentLocalEngine = engine
      if (backend === "local-chromium") localChromiumInstalled = true
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
 * A `BrowserEngine` whose first call creates the router's local session.
 * `routeEngine` is synchronous; session creation is not — this bridges them
 * without making every caller async.
 */
function lazyLocalEngine(backend: LocalEngineBackend): BrowserEngine {
  const ready = () => ensureAgentLocalEngine(backend)
  return new Proxy({ backend } as BrowserEngine, {
    get(target, property) {
      if (property === "backend") return backend
      if (property === "then") return undefined
      // A data property, not a method: report the session's post-fill lock
      // once the session exists (none yet means nothing was filled).
      if (property === "credentialFilled") {
        return agentLocalEngine?.backend === backend ? agentLocalEngine.credentialFilled : false
      }
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

function localRoute(backend: LocalEngineBackend, tier: TrustTier): EngineRoute {
  const engine =
    paneLocalEngine?.backend === backend
      ? paneLocalEngine
      : agentLocalEngine?.backend === backend
        ? agentLocalEngine
        : lazyLocalEngine(backend)
  return { engine, backend, tier, untrusted: tier === "public" }
}

/**
 * Resolve the engine for a TARGET URL (ADR-0201). Callers pass the URL the
 * next call will act on — for a navigation that is the destination, not the
 * page being left.
 *
 * - Cloud / mobile / headless hosts use the bound remote engine.
 * - An explicit preference is honoured, or refused with the reason.
 * - A pane showing a local runtime session keeps the agent on that session.
 * - A public URL the user authorized goes to the cloud browser when it is
 *   ready; otherwise — and for every public URL — to the best desktop engine:
 *   local Chromium once installed, the embedded webview before that.
 * - Loopback URLs stay on the embedded webview.
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
      if (!paneLocalEngine && !agentLocalEngine && !installed) {
        throw new BrowserSessionError(
          "browser_feature_unsupported",
          "Local Chromium is not installed. Install it in Settings → Browser."
        )
      }
      return localRoute("local-chromium", tier)
    case "user-chrome":
      if (
        paneLocalEngine?.backend === "user-chrome" ||
        agentLocalEngine?.backend === "user-chrome"
      ) {
        return localRoute("user-chrome", tier)
      }
      throw new BrowserSessionError(
        "browser_feature_unsupported",
        "No session is attached to your Chrome. Open the browser pane, choose “Your Chrome”, and allow the connection in Chrome."
      )
    case "auto":
    default:
      break
  }

  if (profile === "cloud-companion" || profile === "mobile-companion" || profile === "headless") {
    return remoteRoute()
  }
  // The user chose a local runtime backend in the pane: drive what they see.
  if (paneLocalEngine) return localRoute(paneLocalEngine.backend, tier)
  if (tier === "trusted") return embeddedRoute()
  if (context.domainAuthorized === true && remoteReady) return remoteRoute()
  // Authorized-but-no-cloud and unauthorized public URLs alike: the best
  // engine this desktop can run itself, instead of throwing.
  if (agentLocalEngine?.backend === "user-chrome") return localRoute("user-chrome", tier)
  // `profile` is the desktop here, so the shell half of the check holds.
  return bestLocalDesktopBackend({ tauri: true, localChromiumInstalled: installed }) ===
    "local-chromium"
    ? localRoute("local-chromium", tier)
    : embeddedRoute()
}
