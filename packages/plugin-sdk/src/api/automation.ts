/**
 * Plugin SDK - `automation` capability runtime surface.
 *
 * Re-exports the desktop automation API exposed as `ctx.automation`. The host
 * permission guard and Rust automation policy remain the authoritative safety
 * gates; this file is only a stable SDK import path.
 */

export { createAutomationAPI } from "@/lib/plugin/api/automation-api"
export type { PluginAutomationAPI } from "@/lib/plugin/api/automation-api"

export type {
  AutomationError,
  ButtonTransition,
  Capabilities,
  ClickOpts,
  ClickTarget,
  DragOpts,
  ElementInfo,
  ElementRef,
  EventFilter,
  EventKind,
  ImageFormat,
  KeyChord,
  Locator,
  MonitorInfo,
  MouseButton,
  PatternKind,
  Platform,
  Point,
  Rect,
  Screenshot,
  ScreenshotOpts,
  ScrollOpts,
  ScrollTarget,
  TreeOpts,
  TypeOpts,
  WindowOp,
} from "@/lib/automation/types"

/**
 * The guarded desktop-automation client. `ctx.automation` is the narrow,
 * permission-checked surface most plugins want; `desktop` is the full client
 * the host itself drives, exposed here for plugins whose whole reason to exist
 * is computer use. Every call still passes a `CallContext` naming the calling
 * surface, so the consent tier and audit trail stay attributable.
 */
export { desktop, listenUiaEvents, UIA_EVENT_NAME } from "@/lib/automation/client"

export type {
  CallContext,
  Surface as AutomationSurface,
  UiaEventPayload,
} from "@/lib/automation/client"

export type {
  ActionRequest,
  AppLocator,
  ElementHandle,
  GetAppStateOptions,
} from "@/lib/automation/types"
