/**
 * The plugin contract's share of `lib/browser/protocol.ts`, which re-exports these.
 */
import type { ElementRect, ElementSelectionCore } from "../../types/element-selection"

/**
 * One element the user pointed at IN A PAGE.
 *
 * Every field describing the element itself now lives on
 * {@link ElementSelectionCore} (`types/element-selection.ts`), shared with the
 * artifact preview's picker — the DOM does not become a different thing because
 * of what is hosting it. What stays here is exactly what only a browser has:
 * the pane it came from, and the page it was on.
 *
 * The split is purely additive and the published field set is unchanged, which
 * matters because `packages/plugin-sdk/src/api/browser.ts` re-exports this type
 * to plugin authors (ADR-0155/0156).
 */
export interface BrowserSelection extends ElementSelectionCore {
  paneId: string
  pageUrl: string
  pageTitle: string
  /** What the user targeted. Area selections intentionally carry empty element fields. */
  kind?: "element" | "area" | "text"
  /** Exact text represented by the browser's current Range. */
  selectedText?: string
}

export type TrustTier = "trusted" | "public"

/** One ref'd node in an agent snapshot of the page's accessibility tree. */
export interface SnapshotNode {
  ref: string
  role: string
  name: string
  tag: string
  rect: ElementRect
  /** Always null for a secret (password) field — see `secret`. */
  value: string | null
  /** A password-type field: its value is never reported (ADR-0201). */
  secret?: boolean
  state: { disabled: boolean; checked: boolean | null; expanded: boolean | null }
  /**
   * True when the node lives inside a (same-origin) iframe. Its `rect` is then
   * frame-relative — act on it by `ref`, not by coordinate.
   */
  frame?: boolean
}

/** Options for `browser_snapshot`. */
export interface SnapshotOptions {
  /** Also surface salient non-interactive text (headings, list items, …). */
  includeText?: boolean
  /**
   * ADR-0127: bypass the embedded engine's snapshot cache and re-walk the DOM
   * even when no `browser://snapshot` invalidation arrived since the last
   * walk. The cache is safe by construction (every engine mutation and every
   * DOM-change marker invalidates it); this is the escape hatch for a caller
   * that knows better (e.g. a canvas-heavy page the observer cannot see).
   */
  fresh?: boolean
}

/** Result of `browser_evaluate` — the page helper's value/error envelope. */
export interface EvaluateResult extends BrowserDialogState {
  ok: boolean
  value?: unknown
  error?: string
  generation?: number
  /**
   * Stable refusal code when the engine declined to evaluate (ADR-0201), e.g.
   * `browser_human_input_required` after a vault credential was filled.
   */
  code?: string
}

/** A full accessibility-tree snapshot the model acts against by `ref`. */
export interface BrowserSnapshot {
  generation: number
  url: string
  title: string
  nodes: SnapshotNode[]
  /** Third-party subresource domains blocked by the remote session policy. */
  blockedDomains?: string[]
}

export interface BrowserDialog {
  type: "alert" | "beforeunload" | "confirm" | "prompt"
  message: string
  defaultValue: string
}

export interface BrowserDialogState {
  dialogPending?: boolean
  dialog?: BrowserDialog
}

/** Result of a `browser_*` mutating action. `generation` is the live tree id. */
export interface BrowserActionResult extends BrowserDialogState {
  ok: boolean
  error: string | null
  generation: number
  /**
   * Stable refusal code, when the engine declined the action (ADR-0201), e.g.
   * `browser_human_input_required` for an agent typing into a secret field.
   */
  code?: string
}

/** A captured console line from the previewed page. */
export interface ConsoleEntry {
  level: "log" | "info" | "warn" | "error" | "debug"
  text: string
  ts: number
}

/** A captured network request (status/timing only — not the response body). */
export interface NetworkEntry {
  /** Chromium backends: the id `browser_network_request` takes (ADR-0201). */
  id?: string
  url: string
  method: string
  status: number
  ok: boolean
  durationMs: number | null
}
