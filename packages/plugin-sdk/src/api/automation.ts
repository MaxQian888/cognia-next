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
