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

/**
 * Screen capture through the WebView, not the native automation stack.
 *
 * `desktop.screenshot(...)` above is the OS-level capture: it needs the
 * screen-recording permission and only exists on the desktop shell.
 * `captureScreenshot()` goes through `navigator.mediaDevices.getDisplayMedia()`
 * instead — the browser owns the consent prompt and the source picker, so it
 * works in every shell, and it returns a PNG `File` ready to attach. Resolves
 * `null` when the user cancels or the API is unavailable; that is a normal
 * outcome, not an error.
 */
export { captureScreenshot } from "@/lib/ui/screenshot"

/**
 * The computer-use policy in force for a session — the character's
 * `computerUseSettings`, resolved for the turn. A tool that automates the
 * desktop MUST read this rather than assume: it carries the user's allowed
 * action set and confinement, and the host applies none of it once a plugin
 * tool takes over.
 */
export { getActiveComputerUseSettings } from "@/lib/claude/computer-use-active-settings"
export type { ActiveComputerUseSettings } from "@/lib/claude/computer-use-active-settings"
