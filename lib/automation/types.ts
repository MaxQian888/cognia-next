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
import type {
  AutomationError,
  ElementRef,
  KeyChord,
} from "@cognia/plugin-contract/lib/automation/types"
export type {
  ActionEvidence,
  ActionMethod,
  ActionPolicyDecision,
  ActionResult,
  ActionStatus,
  AutomationError,
  ButtonTransition,
  Capabilities,
  ClickOpts,
  ClickTarget,
  CoordinateSpace,
  ElementInfo,
  ElementRef,
  EventFilter,
  EventKind,
  ExpandedElements,
  ImageFormat,
  InstructionPack,
  KeyChord,
  MonitorInfo,
  PatternKind,
  Platform,
  PreferredLocator,
  Rect,
  ResolvedApplication,
  Screenshot,
  ScreenshotOpts,
  ScrollTarget,
  TreeOpts,
  TruncationDescriptor,
  TypeOpts,
  UiStateRevision,
  UiSurface,
  UiTreeDiff,
  UiTreeNode,
  UiTreeProjection,
  WindowOp,
  ZoomedRegion,
} from "@cognia/plugin-contract/lib/automation/types"

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

/** Helper to construct an ElementRef from a raw string. */
export function elementRef(raw: string): ElementRef {
  return raw
}

export function elementRefValue(r: ElementRef): string {
  return r
}

export function keyChord(raw: string): KeyChord {
  return raw
}

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
