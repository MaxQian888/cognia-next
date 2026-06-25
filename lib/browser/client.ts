/**
 * Renderer-facing client for the in-app browser Tauri command surface
 * (`src-tauri/src/browser/commands.rs`). Thin pass-throughs via the shared
 * `transport` so web/mobile shells reject cleanly rather than throwing.
 */
import type { Screenshot } from "@/lib/automation/types"
import type {
  BrowserActionResult,
  BrowserSnapshot,
  ConsoleEntry,
  ElementRect,
  NetworkEntry,
} from "@/lib/browser/protocol"
import { transport } from "@/lib/tauri"

export const browserClient = {
  /** Create or re-navigate the embedded preview at the reserved rect. */
  embedCreate: (url: string, rect: ElementRect) =>
    transport.call<string>("browser_embed_create", { url, ...rect }),
  embedSetBounds: (rect: ElementRect) =>
    transport.call<void>("browser_embed_set_bounds", { ...rect }),
  embedSetVisible: (visible: boolean, rect: ElementRect) =>
    transport.call<void>("browser_embed_set_visible", { visible, ...rect }),
  embedNavigate: (url: string) => transport.call<void>("browser_embed_navigate", { url }),
  embedReload: () => transport.call<void>("browser_embed_reload", {}),
  embedSetSelectMode: (on: boolean) =>
    transport.call<void>("browser_embed_set_select_mode", { on }),
  /** Capture the embedded preview's on-screen region as a PNG screenshot. */
  embedCapture: (rect: ElementRect) =>
    transport.call<Screenshot>("browser_embed_capture", { ...rect }),
  embedDestroy: () => transport.call<void>("browser_embed_destroy", {}),

  // --- Agent browser loop (Phase 1) ---------------------------------------
  /** Pull the accessibility-tree snapshot, unwrapping the ok/error envelope. */
  embedSnapshot: async (): Promise<BrowserSnapshot> => {
    const raw = await transport.call<string>("browser_embed_snapshot", {})
    const env = JSON.parse(raw) as {
      ok: boolean
      error: string | null
      snapshot: BrowserSnapshot | null
    }
    if (!env.ok || !env.snapshot) throw new Error(env.error ?? "snapshot failed")
    return env.snapshot
  },
  /** Act on a ref'd element (click/type/fill/select/hover/focus). */
  embedAct: async (
    reference: string,
    action: string,
    args: Record<string, unknown>
  ): Promise<BrowserActionResult> => {
    const raw = await transport.call<string>("browser_embed_act", {
      reference,
      action,
      args: JSON.stringify(args ?? {}),
    })
    return JSON.parse(raw) as BrowserActionResult
  },
  embedReadConsole: async (): Promise<ConsoleEntry[]> =>
    JSON.parse(await transport.call<string>("browser_embed_drain_console", {})) as ConsoleEntry[],
  embedReadNetwork: async (): Promise<NetworkEntry[]> =>
    JSON.parse(await transport.call<string>("browser_embed_drain_network", {})) as NetworkEntry[],
  embedBack: () => transport.call<void>("browser_embed_back", {}),
  embedForward: () => transport.call<void>("browser_embed_forward", {}),
  embedStop: () => transport.call<void>("browser_embed_stop", {}),
  embedGetUrl: () => transport.call<string>("browser_embed_get_url", {}),
  embedGetTitle: () => transport.call<string>("browser_embed_get_title", {}),
}

export type BrowserClient = typeof browserClient
