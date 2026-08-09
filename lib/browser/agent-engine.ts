/**
 * Agent-facing browser engine abstraction. Phase 1 ships only the embedded
 * webview and private WorkspaceRuntime Chromium engines behind the same router.
 * The trust tier (`resolveTrustTier`) decides routing and whether the page
 * content must be treated as untrusted. See ADR-0055.
 */
import type { Screenshot } from "@/lib/automation/types"
import { emitAgentActivity } from "@/lib/browser/agent-activity"
import { browserClient } from "@/lib/browser/client"
import { getActivePaneRect } from "@/lib/browser/pane-rect"
import {
  BrowserSessionError,
  type BrowserPageSummary,
  type BrowserDownloadSummary,
} from "@/lib/browser/session-types"
import { detectHostProfile, type HostProfile } from "@/lib/platform/capabilities"
import {
  resolveTrustTier,
  type BrowserActionResult,
  type BrowserDialogState,
  type BrowserSnapshot,
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
  /** Evaluate a JS expression in the page (trust-gated by the caller). */
  evaluate(expr: string): Promise<EvaluateResult>
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
}

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

/** Drives the in-app embedded webview via the Tauri `browser_embed_*` commands. */
export class EmbeddedEngine implements BrowserEngine {
  navigate(url: string) {
    emitAgentActivity(`navigate ${url}`)
    return browserClient.embedNavigate(url)
  }
  snapshot(opts?: SnapshotOptions) {
    return browserClient.embedSnapshot(opts)
  }
  act(reference: string, action: string, args: Record<string, unknown>) {
    emitAgentActivity(`${action} ${reference}`)
    return browserClient.embedAct(reference, action, args)
  }
  pressKey(key: string, reference = "") {
    emitAgentActivity(`key ${key}`)
    return browserClient.embedAct(reference, "key", { key })
  }
  scroll(args: ScrollArgs) {
    emitAgentActivity(
      args.reference ? `scroll ${args.reference}` : `scroll ${args.direction ?? "down"}`
    )
    const { reference = "", ...rest } = args
    return browserClient.embedAct(reference, "scroll", rest as Record<string, unknown>)
  }
  evaluate(expr: string) {
    emitAgentActivity("evaluate")
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
    return browserClient.embedBack()
  }
  forward() {
    emitAgentActivity("forward")
    return browserClient.embedForward()
  }
  reload() {
    emitAgentActivity("reload")
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
  async closePage(pageId: string): Promise<void> {
    await this.activatePage(pageId)
    await this.stop()
    await this.navigate("about:blank")
  }
  async createPage(_url?: string): Promise<BrowserPageSummary> {
    throw new BrowserSessionError(
      "browser_feature_unsupported",
      "Creating pages is not supported by the embedded browser"
    )
  }
  async drag(_sourceRef: string, _targetRef: string): Promise<BrowserActionResult> {
    throw new BrowserSessionError(
      "browser_feature_unsupported",
      "Drag and drop is not supported by the embedded browser"
    )
  }
  async handleDialog(_args: HandleDialogArgs): Promise<BrowserActionResult> {
    throw new BrowserSessionError(
      "browser_feature_unsupported",
      "Native dialogs are not supported by the embedded browser"
    )
  }
  async setFiles(_reference: string, _paths: string[]): Promise<void> {
    throw new BrowserSessionError(
      "browser_feature_unsupported",
      "File upload is not supported by the embedded browser"
    )
  }
  async downloads(): Promise<BrowserDownloadSummary[]> {
    throw new BrowserSessionError(
      "browser_feature_unsupported",
      "Download quarantine is not supported by the embedded browser"
    )
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
          "Scoped screenshots are not supported by the embedded browser"
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
}

const embedded = new EmbeddedEngine()

export interface EngineRoute {
  engine: BrowserEngine
  backend: "embedded" | "remote-chromium"
  tier: TrustTier
  /** Page content must be treated as untrusted (public origin). */
  untrusted: boolean
}

export interface EngineRoutingContext {
  hostProfile?: HostProfile
  backendPreference?: "auto" | "embedded" | "remote-chromium"
  remoteEnabled?: boolean
  remoteHealthy?: boolean
  domainAuthorized?: boolean
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

/**
 * Resolve the host-neutral engine for a target URL. Desktop localhost remains
 * embedded by default; cloud/mobile/headless and explicitly-authorized public
 * origins use the currently-bound RemoteChromiumEngine. Active sessions never
 * migrate implicitly between backends.
 */
export function routeEngine(url: string, context: EngineRoutingContext = {}): EngineRoute {
  const tier = resolveTrustTier(url)
  const preference = context.backendPreference ?? "auto"
  const remoteReady =
    !!remoteEngine &&
    (context.remoteEnabled ?? remoteReadiness.enabled) &&
    (context.remoteHealthy ?? remoteReadiness.healthy)
  const profile = context.hostProfile ?? (remoteEngine ? detectHostProfile() : "desktop")
  const useRemote =
    preference === "remote-chromium" ||
    (preference === "auto" &&
      (profile === "cloud-companion" ||
        profile === "mobile-companion" ||
        profile === "headless" ||
        (tier === "public" && context.domainAuthorized === true)))
  if (useRemote) {
    if (!remoteReady || !remoteEngine) {
      throw new BrowserSessionError(
        "browser_feature_unsupported",
        "Remote browser is not enabled or healthy"
      )
    }
    return {
      engine: remoteEngine,
      backend: "remote-chromium",
      tier,
      untrusted: tier === "public",
    }
  }
  return { engine: embedded, backend: "embedded", tier, untrusted: tier === "public" }
}
