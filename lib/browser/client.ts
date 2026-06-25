/**
 * Renderer-facing client for the in-app browser Tauri command surface
 * (`src-tauri/src/browser/commands.rs`). Thin pass-throughs via the shared
 * `transport` so web/mobile shells reject cleanly rather than throwing.
 */
import type { Screenshot } from "@/lib/automation/types"
import type { ElementRect } from "@/lib/browser/protocol"
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
}

export type BrowserClient = typeof browserClient
