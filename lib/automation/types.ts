/**
 * TypeScript mirror of `src-tauri/src/automation/types.rs`.
 *
 * Field names are camelCase to match `#[serde(rename_all = "camelCase")]` on
 * the Rust side. Discriminated unions use the `kind` tag exactly as serialized
 * by serde `#[serde(tag = "kind")]`.
 *
 * **Source of truth lives on the Rust side.** If you change a field name
 * here, change it in `src-tauri/src/automation/types.rs` too — the worker
 * deserialization is the authoritative validator.
 */

export type Platform = "windows" | "macos" | "linux" | "unsupported"

export interface Capabilities {
  platform: Platform
  hasUia: boolean
  hasInputSim: boolean
  hasScreenshot: boolean
  hasEvents: boolean
  /**
   * The back-end exposes a cross-platform accessibility tree (`readTree` /
   * `find`) independent of Windows UIA. True on the macOS AXAPI back-end and
   * the remote cua sandbox; false on the input-only enigo back-ends (Linux
   * today, and Windows reports its tree through `hasUia` instead). Mirrors
   * `has_a11y_tree` on the Rust `Capabilities` struct.
   */
  hasA11yTree: boolean
  /** Monitors visible to the capture backend (empty for stub/remote). */
  monitors: MonitorInfo[]
}

/**
 * One physical (or virtual) monitor as enumerated by the capture backend.
 * `x`/`y` are virtual-desktop pixels — the same coordinate space `click` /
 * `mouseMove` / `pickAtPoint` use, so a caller can target a specific
 * monitor by offsetting into its rect.
 */
/**
 * The model-facing action contract lives in `./action-schemas` as zod schemas,
 * because the same definition has to serve three consumers: the JSON Schema the
 * plugin tools publish, these TypeScript types, and the parity test that pins
 * the union against the Rust enum. Re-exported here so existing importers of
 * `lib/automation/types` are unaffected.
 */
import type { ElementHandle, MouseButton, UiTreeProjectionKind } from "./action-schemas"

export type {
  ActionRequest,
  ActionStrategy,
  ActionTarget,
  AppLocator,
  DragOpts,
  ElementHandle,
  GetAppStateOptions,
  Locator,
  MouseButton,
  PixelTarget,
  Point,
  ScrollOpts,
  UiAction,
  UiTreeProjectionKind,
} from "./action-schemas"

export interface MonitorInfo {
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  isPrimary: boolean
  scaleFactor: number
}

/**
 * Opaque backend element reference — pass it back unchanged.
 *
 * Rust declares this as `pub struct ElementRef(pub String)`. serde renders a
 * newtype struct transparently, so it crosses the wire as a bare JSON string.
 * This was previously modelled as the one-element tuple `{0: string}`, which
 * meant `elementRef()` produced `["…"]` where the backend expected `"…"` and
 * `elementRefValue()` returned the first *character* of a real ref. Both
 * helpers are now identities, kept so existing call sites stay valid.
 */
export type ElementRef = string

/** Helper to construct an ElementRef from a raw string. */
export function elementRef(raw: string): ElementRef {
  return raw
}

export function elementRefValue(r: ElementRef): string {
  return r
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface ElementInfo {
  elementRef: ElementRef
  name: string | null
  automationId: string | null
  controlType: string | null
  className: string | null
  boundingRect: Rect | null
  isEnabled: boolean
  isFocused: boolean
  processId: number | null
  processName: string | null
  windowTitle: string | null
  children: ElementInfo[] | null
}

export interface TreeOpts {
  maxDepth?: number
  cacheProps?: string[]
}

export type ImageFormat = "png" | "jpeg"

export interface ScreenshotOpts {
  region?: Rect
  format?: ImageFormat
  /**
   * Capture a specific monitor (id from `Capabilities.monitors`).
   * Absent / unknown id falls back to the primary monitor.
   */
  monitorId?: string
}

export interface Screenshot {
  /** base64-encoded image bytes. */
  bytes: string
  width: number
  height: number
  capturedAt: number
  format: ImageFormat
  /**
   * Pre-downscale dimensions — present only when the Rust side shrank the
   * frame (Settings → Automation → Behavior → screenshot scaling). Absent
   * means `width`/`height` ARE the physical pixels. The canonical Rust
   * session surface uses these dimensions for model/source transforms.
   */
  sourceWidth?: number
  sourceHeight?: number
}

export interface ResolvedApplication {
  bundleId: string | null
  path: string | null
  displayName: string
  processId: number
}

export type CoordinateSpace = "globalLogicalPoints" | "screenshotPixels" | "modelPixels"

export interface UiSurface {
  windowId: number | null
  displayId: string | null
  logicalBounds: Rect
  pixelWidth: number
  pixelHeight: number
  scaleFactor: number
  coordinateSpace: CoordinateSpace
}

export interface UiTreeNode {
  handle: ElementHandle
  parentIndex: number | null
  element: ElementInfo
}

export interface UiTreeProjection {
  nodes: UiTreeNode[]
  totalNodes: number
  truncated: boolean
}

export interface UiTreeDiff {
  fromRevision: number
  toRevision: number
  added: ElementInfo[]
  removed: string[]
  updated: ElementInfo[]
}

export interface TruncationDescriptor {
  reason: string
  materializedNodes: number
  omittedNodes: number
}

export interface PreferredLocator {
  purpose: string
  automationId: string | null
  role: string | null
  name: string | null
}

/**
 * Cognia-authored, bundle-ID-scoped navigation guidance. The schema cannot
 * express policy, consent, redaction, confirmations, or target allow-lists.
 */
export interface InstructionPack {
  bundleId: string
  version: number
  guidance: string[]
  preferredLocators: PreferredLocator[]
  loadingRoleHints: string[]
}

export interface UiStateRevision {
  sessionId: string
  lineageId: string
  revision: number
  turnToken: string
  app: ResolvedApplication
  surface: UiSurface
  screenshot: Screenshot | null
  projection: UiTreeProjectionKind
  tree: UiTreeProjection
  diff: UiTreeDiff | null
  truncation: TruncationDescriptor[]
  instructionPack: InstructionPack | null
  capturedAt: number
  /**
   * Set when `AutomationSettings.screenshotDedup` withheld a frame that was
   * byte-identical to the one this app session last showed the model.
   * `screenshot` is still present and still carries the dimensions a pixel
   * target needs — only `bytes` is empty. Absent means the frame is whole.
   * Applied by the Rust `automation::screenshot_dedup` module, and only for
   * model-facing surfaces (`computerUse` / `mcp` / `plugin`).
   */
  screenshotUnchanged?: boolean
  /** Short text the model reads in place of a withheld frame. */
  screenshotNote?: string
}

/**
 * One `zoom` result: a crop of the revision's frame, plus where that crop sits
 * inside it. `region` is in the pixel space of the frame the caller was shown,
 * and `scale` converts a point measured in the crop back into that space.
 */
export interface ZoomedRegion {
  sessionId: string
  lineageId: string
  revision: number
  screenshot: Screenshot
  /**
   * Where the crop sits, in the pixel space of the frame the caller was shown.
   * Without it a zoom is worse than useless for grounding: the caller would
   * report coordinates in crop space and the click would land elsewhere.
   */
  region: Rect
  /**
   * Crop pixels per `region` pixel. The crop is taken from the frame as
   * captured, which is larger than the frame the caller was shown whenever
   * screenshot scaling is on, so a point read off the crop maps back with
   * `region.origin + cropPoint / scale`. It is `1` when nothing was scaled.
   */
  scale: number
}

export interface ExpandedElements {
  nodes: UiTreeNode[]
  continuationToken: string | null
}

export type ActionStatus = "delivered" | "notDelivered" | "refused" | "unknown"
export type ActionMethod = "ax" | "synthetic"

export interface ActionEvidence {
  kind: string
  message: string
  revision: number | null
}

export interface ActionPolicyDecision {
  allowed: boolean
  reason: string | null
}

export interface ActionResult {
  status: ActionStatus
  method: ActionMethod | null
  beforeRevision: number
  afterRevision: number | null
  evidence: ActionEvidence[]
  policyDecision: ActionPolicyDecision
  durationMs: number
}

export type ClickTarget =
  { kind: "element"; elementRef: ElementRef } | { kind: "point"; x: number; y: number }

/**
 * Key chord, e.g. `"ctrl+shift+t"`, `"alt+F4"`, `"Enter"`.
 *
 * Rust `pub struct KeyChord(pub String)` — a newtype struct, so this is a bare
 * JSON string on the wire, not a one-element tuple. See {@link ElementRef}.
 */
export type KeyChord = string

export function keyChord(raw: string): KeyChord {
  return raw
}

export interface ClickOpts {
  button?: MouseButton
  double?: boolean
  modifier?: KeyChord
  /**
   * When true (default), clicking an `Element`-target tries UIA patterns
   * (`Invoke` → `Toggle` → `SelectionItem`) before falling back to a
   * coordinate click at the element's bounding-rect center. Pass `false`
   * to force a coordinate click — useful for games / custom-drawn surfaces
   * UIA can't see, or to drive an exact pixel-level interaction.
   */
  useNative?: boolean
  /**
   * Number of consecutive clicks (1 = single, 2 = double, 3 = triple). When
   * unset, falls back to `double` (true → 2). The Rust backend repeats
   * clicks at the OS double-click cadence so applications see a real
   * native triple-click rather than three independent presses.
   */
  count?: 1 | 2 | 3
}

/**
 * Scroll target — either a point on the screen or an element. For
 * elements, the backend prefers UIA `ScrollPattern` / `ScrollItemPattern`
 * over wheel events when available.
 */
export type ScrollTarget =
  { kind: "point"; x: number; y: number } | { kind: "element"; elementRef: ElementRef }

/**
 * Scroll deltas. Positive `dy` scrolls down; positive `dx` scrolls right.
 * Magnitude is in OS-native wheel units (typically 120 per notch).
 */

/** Mouse button transition for `mouse_button` direct down/up control. */
export type ButtonTransition = "down" | "up"

export interface TypeOpts {
  delayMs?: number
  target?: ElementRef
}

export type PatternKind =
  | "invoke"
  | "toggle"
  | "selectionItem"
  | "value"
  | "text"
  | "rangeValue"
  | "window"
  | "transform"
  | "expandCollapse"
  | "scrollItem"

export type WindowOp =
  | { kind: "focus" }
  | { kind: "close" }
  | { kind: "minimize" }
  | { kind: "maximize" }
  | { kind: "restore" }
  | { kind: "resize"; rect: Rect }

/**
 * Mirrors the Rust `EventKind` in
 * `crates/cognia-automation/src/automation/types.rs`. `text-selection-changed`
 * is opt-in only: it fires on every caret move in every text control, so it is
 * never part of the default filter.
 */
export type EventKind =
  "focus-changed" | "structure-changed" | "property-changed" | "text-selection-changed"

export interface EventFilter {
  kinds?: EventKind[]
  scope?: ElementRef
}

/**
 * Discriminated union of every `AutomationError` variant. The Rust side
 * serializes errors as JSON strings inside `Result<T, String>` (a Tauri
 * convention); use `parseAutomationError()` to recover the typed shape.
 */
export type AutomationError =
  | { code: "UNSUPPORTED_PLATFORM" }
  | { code: "KILL_SWITCH_ACTIVE" }
  | { code: "PERMISSION_DENIED"; reason: string }
  | { code: "USER_DECLINED" }
  | { code: "WHITELIST_MISS" }
  | { code: "ELEMENT_NOT_FOUND" }
  | { code: "STALE_ELEMENT" }
  | { code: "BACKEND_ERROR"; message: string }
  | { code: "INTERNAL"; message: string }

/**
 * Tauri commands return `Result<T, String>`. The Rust side serializes
 * `AutomationError` as a JSON string before raising, so the renderer can
 * recover the typed shape by `JSON.parse`-ing the error string.
 */
export function parseAutomationError(raw: unknown): AutomationError | null {
  if (typeof raw !== "string") return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && typeof parsed.code === "string") {
      return parsed as AutomationError
    }
  } catch {
    // Not JSON — fall through.
  }
  return null
}

/**
 * Stringify an AutomationError for UI display.
 */
export function automationErrorMessage(err: AutomationError): string {
  switch (err.code) {
    case "UNSUPPORTED_PLATFORM":
      return "Desktop automation is not supported on this platform"
    case "KILL_SWITCH_ACTIVE":
      return "Automation kill switch is active"
    case "PERMISSION_DENIED":
      return `Permission denied: ${err.reason}`
    case "USER_DECLINED":
      return "User declined consent"
    case "WHITELIST_MISS":
      return "Target window is not on the whitelist"
    case "ELEMENT_NOT_FOUND":
      return "Element not found"
    case "STALE_ELEMENT":
      return "Element reference is stale"
    case "BACKEND_ERROR":
      return `Backend error: ${err.message}`
    case "INTERNAL":
      return `Internal error: ${err.message}`
  }
}
