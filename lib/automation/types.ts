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

export interface ElementRef {
  /** Opaque ref — pass it back unchanged. */
  0: string
}

/** Helper to construct an ElementRef from a raw string. */
export function elementRef(raw: string): ElementRef {
  return [raw] as unknown as ElementRef
}

export function elementRefValue(r: ElementRef): string {
  return (r as unknown as string[])[0]
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

export interface Locator {
  name?: string
  nameContains?: string
  automationId?: string
  controlType?: string
  className?: string
  processId?: number
  processName?: string
  windowTitleContains?: string
  depth?: number
  from?: ElementRef
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

export type AppLocator =
  | { kind: "bundleId"; bundleId: string }
  | { kind: "path"; path: string }
  | { kind: "displayName"; displayName: string }

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

export interface GetAppStateOptions {
  disableDiff?: boolean
  allowLaunch?: boolean
  maxNodes?: number
  maxDepth?: number
  projection?: UiTreeProjectionKind
}

export type UiTreeProjectionKind = "model" | "inspector"

export interface ElementHandle {
  sessionId: string
  lineageId: string
  revision: number
  index: number
  fingerprint: string
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

export interface ExpandedElements {
  nodes: UiTreeNode[]
  continuationToken: string | null
}

export type ActionStrategy = "semantic" | "pixel" | "auto"

export interface PixelTarget {
  sessionId: string
  lineageId: string
  revision: number
  point: Point
  screenshotWidth: number
  screenshotHeight: number
}

export type ActionTarget =
  { kind: "element"; handle: ElementHandle } | { kind: "pixel"; target: PixelTarget }

export type UiAction =
  | { kind: "click"; button?: MouseButton; count?: number }
  | { kind: "drag"; to: Point; opts?: DragOpts }
  | { kind: "scroll"; opts?: ScrollOpts }
  | { kind: "pressKey"; chord: KeyChord }
  | { kind: "typeText"; text: string }
  | { kind: "setValue"; value: string }
  | { kind: "selectText"; start: number; end: number }
  | { kind: "secondaryAction"; name: string }

export interface ActionRequest {
  turnToken: string
  target: ActionTarget
  action: UiAction
  strategy: ActionStrategy
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

export type MouseButton = "left" | "right" | "middle"

export interface KeyChord {
  /** Format: `"ctrl+shift+t"`, `"alt+F4"`, `"Enter"`. */
  0: string
}

export function keyChord(raw: string): KeyChord {
  return [raw] as unknown as KeyChord
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

/** 2D screen coordinate, mirror of Rust `automation::types::Point`. */
export interface Point {
  x: number
  y: number
}

export interface DragOpts {
  button?: MouseButton
  /** Total move duration in milliseconds (default ~150). */
  durationMs?: number
  /** Number of interpolated waypoints (default ~12). */
  steps?: number
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
export interface ScrollOpts {
  dx?: number
  dy?: number
}

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
