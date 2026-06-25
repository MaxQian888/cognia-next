/**
 * Agent-facing browser engine abstraction. Phase 1 ships only the embedded
 * webview engine; Phase 2 adds an external-MCP engine behind the same router.
 * The trust tier (`resolveTrustTier`) decides routing and whether the page
 * content must be treated as untrusted. See ADR-0055.
 */
import type { Screenshot } from "@/lib/automation/types"
import { emitAgentActivity } from "@/lib/browser/agent-activity"
import { browserClient } from "@/lib/browser/client"
import { getActivePaneRect } from "@/lib/browser/pane-rect"
import {
  resolveTrustTier,
  type BrowserActionResult,
  type BrowserSnapshot,
  type ConsoleEntry,
  type NetworkEntry,
  type TrustTier,
} from "@/lib/browser/protocol"

export interface BrowserEngine {
  navigate(url: string): Promise<void>
  snapshot(): Promise<BrowserSnapshot>
  act(
    reference: string,
    action: string,
    args: Record<string, unknown>
  ): Promise<BrowserActionResult>
  readConsole(): Promise<ConsoleEntry[]>
  readNetwork(): Promise<NetworkEntry[]>
  back(): Promise<void>
  forward(): Promise<void>
  reload(): Promise<void>
  stop(): Promise<void>
  getPage(): Promise<{ url: string; title: string }>
  waitForText(text: string, opts?: WaitForOptions): Promise<WaitForResult>
  screenshot(): Promise<Screenshot>
}

export interface WaitForOptions {
  /** Wait for the text to appear (default) or disappear. */
  mode?: "appear" | "disappear"
  timeoutMs?: number
  intervalMs?: number
}

export interface WaitForResult {
  ok: boolean
  timedOut: boolean
}

/** Drives the in-app embedded webview via the Tauri `browser_embed_*` commands. */
export class EmbeddedEngine implements BrowserEngine {
  navigate(url: string) {
    emitAgentActivity(`navigate ${url}`)
    return browserClient.embedNavigate(url)
  }
  snapshot() {
    return browserClient.embedSnapshot()
  }
  act(reference: string, action: string, args: Record<string, unknown>) {
    emitAgentActivity(`${action} ${reference}`)
    return browserClient.embedAct(reference, action, args)
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
  async waitForText(text: string, opts: WaitForOptions = {}): Promise<WaitForResult> {
    const mode = opts.mode ?? "appear"
    const timeoutMs = opts.timeoutMs ?? 5000
    const intervalMs = opts.intervalMs ?? 200
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const has = await browserClient.embedHasText(text)
      if ((mode === "appear" && has) || (mode === "disappear" && !has)) {
        return { ok: true, timedOut: false }
      }
      if (Date.now() >= deadline) return { ok: false, timedOut: true }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  screenshot(): Promise<Screenshot> {
    const rect = getActivePaneRect()
    if (!rect) return Promise.reject(new Error("preview is not open"))
    emitAgentActivity("screenshot")
    return browserClient.embedCapture(rect)
  }
}

const embedded = new EmbeddedEngine()

export interface EngineRoute {
  engine: BrowserEngine
  tier: TrustTier
  /** Page content must be treated as untrusted (public origin). */
  untrusted: boolean
}

/**
 * Resolve the engine for a target URL. The embedded engine is the only in-app
 * engine; the `public` tier is flagged `untrusted`. Transparent delegation to an
 * external Playwright-MCP "engine" is NOT possible (a renderer plugin can only
 * invoke its own tools; external MCP tools live in the sidecar, callable only by
 * the model), so public-site automation is GUIDANCE-BASED: the `untrusted` flag
 * + the browser-tools availability context steer the model to the separately
 * attached `mcp__playwright__*` tools. See ADR-0055 §Phase 2.
 */
export function routeEngine(url: string): EngineRoute {
  const tier = resolveTrustTier(url)
  return { engine: embedded, tier, untrusted: tier === "public" }
}
