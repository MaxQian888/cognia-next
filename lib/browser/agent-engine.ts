/**
 * Agent-facing browser engine abstraction. Phase 1 ships only the embedded
 * webview engine; Phase 2 adds an external-MCP engine behind the same router.
 * The trust tier (`resolveTrustTier`) decides routing and whether the page
 * content must be treated as untrusted. See ADR-0055.
 */
import { emitAgentActivity } from "@/lib/browser/agent-activity"
import { browserClient } from "@/lib/browser/client"
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
  getPage(): Promise<{ url: string; title: string }>
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
    return browserClient.embedBack()
  }
  forward() {
    return browserClient.embedForward()
  }
  reload() {
    return browserClient.embedReload()
  }
  async getPage() {
    const [url, title] = await Promise.all([
      browserClient.embedGetUrl(),
      browserClient.embedGetTitle(),
    ])
    return { url, title }
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
 * Resolve the engine for a target URL. Phase 1 always returns the embedded
 * engine; the `public` tier is flagged `untrusted` (Phase 2 routes it to the
 * external-MCP engine instead).
 */
export function routeEngine(url: string): EngineRoute {
  const tier = resolveTrustTier(url)
  return { engine: embedded, tier, untrusted: tier === "public" }
}
