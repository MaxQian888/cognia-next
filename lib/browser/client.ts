/**
 * Renderer-facing client for the in-app browser Tauri command surface
 * (`src-tauri/src/browser/commands.rs`). Thin pass-throughs via the shared
 * `transport` so web/mobile shells reject cleanly rather than throwing.
 */
import type { Screenshot } from "@/lib/automation/types"
import type {
  BrowserActionResult,
  BrowserSnapshot,
  BrowserSelection,
  ConsoleEntry,
  ElementRect,
  EvaluateResult,
  NetworkEntry,
  NetworkState,
  SnapshotOptions,
} from "@/lib/browser/protocol"
import type { RecordedStep } from "@/lib/browser/recording/protocol"
import { transport } from "@/lib/tauri"

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)

function isBrowserSelection(value: unknown): value is BrowserSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  const rect = item.rect
  if (!rect || typeof rect !== "object" || Array.isArray(rect)) return false
  const box = rect as Record<string, unknown>
  return (
    typeof item.paneId === "string" &&
    typeof item.selector === "string" &&
    typeof item.domPath === "string" &&
    typeof item.tagName === "string" &&
    (item.id === null || typeof item.id === "string") &&
    (item.classes === null || typeof item.classes === "string") &&
    isFiniteNumber(box.x) &&
    isFiniteNumber(box.y) &&
    isFiniteNumber(box.width) &&
    isFiniteNumber(box.height) &&
    typeof item.outerHTML === "string" &&
    typeof item.text === "string" &&
    typeof item.pageUrl === "string" &&
    typeof item.pageTitle === "string"
  )
}

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
  /** Tear down the post-selection info panel + outline in the previewed page. */
  embedClearSelection: () => transport.call<void>("browser_embed_clear_selection", {}),
  /** Push localized info-panel toggle labels into the previewed page. */
  embedSetPanelLabels: (labels: { details: string; collapse: string }) =>
    transport.call<void>("browser_embed_set_panel_labels", { labels: JSON.stringify(labels) }),
  embedSetFrozen: (on: boolean) =>
    transport.call<void>("browser_embed_set_frozen", { on }),
  /** Freeze dynamic content, wait for the paused frame to settle, then capture. */
  embedCapture: async (rect: ElementRect) => {
    try {
      await transport.call<void>("browser_embed_set_frozen", { on: true })
      return await transport.call<Screenshot>("browser_embed_capture", { ...rect })
    } finally {
      await transport.call<void>("browser_embed_set_frozen", { on: false }).catch(() => undefined)
    }
  },
  embedDestroy: () => transport.call<void>("browser_embed_destroy", {}),

  // --- Agent browser loop (Phase 1) ---------------------------------------
  /**
   * Pull the accessibility-tree snapshot, unwrapping the ok/error envelope.
   * `opts.includeText` surfaces salient non-interactive text (headings, list
   * items, etc.) in addition to interactive nodes.
   */
  embedSnapshot: async (opts?: SnapshotOptions): Promise<BrowserSnapshot> => {
    const raw = await transport.call<string>(
      "browser_embed_snapshot",
      opts ? { args: JSON.stringify(opts) } : {}
    )
    const env = JSON.parse(raw) as {
      ok: boolean
      error: string | null
      snapshot: BrowserSnapshot | null
    }
    if (!env.ok || !env.snapshot) throw new Error(env.error ?? "snapshot failed")
    return env.snapshot
  },
  embedDrainSelection: async (): Promise<BrowserSelection[]> => {
    const raw = await transport.call<string>("browser_embed_drain_selection", {})
    const env: unknown = JSON.parse(raw)
    if (!env || typeof env !== "object" || Array.isArray(env)) {
      throw new Error("invalid selection drain envelope")
    }
    const record = env as Record<string, unknown>
    if (typeof record.ok !== "boolean" || !Array.isArray(record.selections)) {
      throw new Error("invalid selection drain envelope")
    }
    if (!record.ok) {
      throw new Error(typeof record.error === "string" ? record.error : "selection drain failed")
    }
    const selections = record.selections
    if (selections.length > 20 || !selections.every(isBrowserSelection)) {
      throw new Error("invalid selection drain payload")
    }
    return selections
  },
  /**
   * Evaluate a JS expression in the embedded page (trust-gated by the caller).
   * Returns the page helper's `{ ok, value }` / `{ ok, error }` envelope.
   */
  embedEvaluate: async (expr: string): Promise<EvaluateResult> => {
    const raw = await transport.call<string>("browser_embed_evaluate", { expr })
    return JSON.parse(raw) as EvaluateResult
  },
  /** Whether the embedded page has an element matching the CSS selector. */
  embedHasSelector: (selector: string) =>
    transport.call<boolean>("browser_embed_has_selector", { selector }),
  /** In-flight + completed request counters for network-idle detection. */
  embedNetworkState: async (): Promise<NetworkState> =>
    JSON.parse(await transport.call<string>("browser_embed_network_state", {})) as NetworkState,
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
  /** Whether the embedded page's visible text currently contains `text`. */
  embedHasText: (text: string) => transport.call<boolean>("browser_embed_has_text", { text }),

  // --- Action recording (ADR-0072) ----------------------------------------
  /** Resolve a recorded selector to a live snapshot ref; "" when not found. */
  embedRefFor: (selector: string) => transport.call<string>("browser_embed_ref_for", { selector }),
  /** Begin a fresh take, discarding anything the page had buffered. */
  embedStartRecord: () => transport.call<string>("browser_embed_start_record", {}),
  /** Re-arm after a navigation, keeping the buffer (see `resumeRecord`). */
  embedResumeRecord: () => transport.call<string>("browser_embed_resume_record", {}),
  embedStopRecord: () => transport.call<string>("browser_embed_stop_record", {}),
  /** Take the steps buffered since the last drain. */
  embedDrainRecord: async (): Promise<RecordedStep[]> =>
    JSON.parse(await transport.call<string>("browser_embed_drain_record", {})) as RecordedStep[],
}

export type BrowserClient = typeof browserClient
