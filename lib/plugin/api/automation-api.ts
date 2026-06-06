/**
 * Plugin Automation API (`ctx.automation`) — drives the real desktop through
 * the Computer Use surface (ADR-0020). Wraps the `lib/automation/client.ts`
 * `desktop.*` command set, tagging every call with `surface: "plugin"` + the
 * plugin id so the Rust per-surface permission gate (tier / whitelist /
 * per-call consent overlay) fires for the plugin surface.
 *
 * TWO gates stack here:
 *   1. The TS PermissionGuard (`createGuardedAPI`) — the plugin must declare
 *      the matching `automation:*` manifest permission, or the call throws.
 *   2. The Rust automation policy — even with the manifest permission, the
 *      host's per-plugin tier / whitelist / per-call consent still applies,
 *      the global kill-switch hard-stops everything, and `enabled: false`
 *      keeps the whole surface off. The plugin never sees the host's settings.
 *
 * Deliberately exposes ONLY the action surface. Host-admin operations
 * (settings get/set, kill-switch, consent respond, virtual-display setup,
 * audit snapshot) are NOT exposed — a plugin must not reconfigure or disarm
 * the user's automation guardrails (parity with `ctx.perf` omitting sampler
 * control). Every permission here is classified DANGEROUS.
 *
 * Desktop-only: on web / mobile the underlying transport rejects with
 * UNSUPPORTED_PLATFORM.
 */

import { desktop } from "@/lib/automation/client"
import type {
  ButtonTransition,
  Capabilities,
  ClickOpts,
  ClickTarget,
  DragOpts,
  ElementInfo,
  ElementRef,
  KeyChord,
  Locator,
  MouseButton,
  Point,
  Screenshot,
  ScreenshotOpts,
  ScrollOpts,
  ScrollTarget,
  TreeOpts,
  TypeOpts,
  WindowOp,
} from "@/lib/automation/types"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"

/** Desktop automation surface exposed to plugins (ADR-0020). */
export interface PluginAutomationAPI {
  // ----------------------------------------------------- read (automation:read)
  /** Report which automation primitives the host platform supports. */
  capabilities(): Promise<Capabilities>
  /** Describe the currently-focused UI element. */
  getFocus(): Promise<ElementInfo>
  /** Read the accessibility tree under `root` (whole desktop when null). */
  readTree(root?: ElementRef | null, opts?: TreeOpts): Promise<ElementInfo[]>
  /** Resolve the first element matching `locator`, or null. */
  find(locator: Locator): Promise<ElementRef | null>
  /** Current cursor position in screen coordinates. */
  cursorPosition(): Promise<Point>
  /** Topmost UI element at the given screen point. */
  pickAtPoint(point: Point): Promise<ElementInfo>

  // --------------------------------------------- screenshot (automation:screenshot)
  /** Capture a desktop screenshot (full screen or a region). */
  screenshot(opts?: ScreenshotOpts): Promise<Screenshot>

  // ---------------------------------------------------- click (automation:click)
  /** Mouse click on a target (point or element). */
  click(target: ClickTarget, opts?: ClickOpts): Promise<void>
  /** Press or release a mouse button (low-level down/up). */
  mouseButton(button: MouseButton, transition: ButtonTransition): Promise<void>

  // ----------------------------------------------------- type (automation:type)
  /** Type literal text into the focused element. */
  type(text: string, opts?: TypeOpts): Promise<void>
  /**
   * Clipboard-paste fast path: the host saves the clipboard, writes `text`,
   * sends Ctrl/Cmd+V, then restores. Prefer over `type` for long text.
   */
  paste(text: string): Promise<void>
  /** Send a keyboard chord (e.g. Ctrl+C). */
  keys(chord: KeyChord): Promise<void>
  /** Hold a key chord down for `durationMs`. */
  holdKey(chord: KeyChord, durationMs: number): Promise<void>

  // ------------------------------------------------- pointer (automation:pointer)
  /** Move the mouse to a point (no click). */
  mouseMove(point: Point): Promise<void>
  /** Drag from one point to another. */
  drag(from: Point, to: Point, opts?: DragOpts): Promise<void>
  /** Scroll a target by the given deltas. */
  scroll(target: ScrollTarget, opts?: ScrollOpts): Promise<void>

  // -------------------------------------------------- window (automation:window)
  /** Focus / close / minimize / maximize / resize a window. */
  windowOp(target: ElementRef, op: WindowOp): Promise<void>
  /** Launch an app by path/name, or focus an existing window by process name. */
  launchApp(app: string, action: "launch" | "focus"): Promise<void>
}

/**
 * Create the desktop Automation API for a plugin. Every call is tagged
 * `surface: "plugin"` + `pluginId` so the Rust gate runs the plugin policy;
 * the TS guard additionally requires the matching `automation:*` permission.
 */
export function createAutomationAPI(pluginId: string): PluginAutomationAPI {
  // The plugin never supplies the call context — we always stamp the plugin
  // surface + id so it can neither impersonate another surface nor drop its id.
  const ctx = { surface: "plugin", pluginId } as const

  const api: PluginAutomationAPI = {
    // read
    capabilities: () => desktop.capabilities(),
    getFocus: () => desktop.getFocus(ctx),
    readTree: (root = null, opts = {}) => desktop.readTree(root, opts, ctx),
    find: (locator) => desktop.find(locator, ctx),
    cursorPosition: () => desktop.cursorPosition(ctx),
    pickAtPoint: (point) => desktop.pickAtPoint(point, ctx),
    // screenshot
    screenshot: (opts = {}) => desktop.screenshot(opts, ctx),
    // click
    click: (target, opts = {}) => desktop.click(target, opts, ctx),
    mouseButton: (button, transition) => desktop.mouseButton(button, transition, ctx),
    // type
    type: (text, opts = {}) => desktop.type(text, opts, ctx),
    paste: (text) => desktop.paste(text, ctx),
    keys: (chord) => desktop.keys(chord, ctx),
    holdKey: (chord, durationMs) => desktop.holdKey(chord, durationMs, ctx),
    // pointer
    mouseMove: (point) => desktop.mouseMove(point, ctx),
    drag: (from, to, opts = {}) => desktop.drag(from, to, opts, ctx),
    scroll: (target, opts = {}) => desktop.scroll(target, opts, ctx),
    // window
    windowOp: (target, op) => desktop.windowOp(target, op, ctx),
    launchApp: (app, action) => desktop.launchApp(app, action, ctx),
  }

  return createGuardedAPI(pluginId, api, {
    capabilities: "automation:read",
    getFocus: "automation:read",
    readTree: "automation:read",
    find: "automation:read",
    cursorPosition: "automation:read",
    pickAtPoint: "automation:read",
    screenshot: "automation:screenshot",
    click: "automation:click",
    mouseButton: "automation:click",
    type: "automation:type",
    paste: "automation:type",
    keys: "automation:type",
    holdKey: "automation:type",
    mouseMove: "automation:pointer",
    drag: "automation:pointer",
    scroll: "automation:pointer",
    windowOp: "automation:window",
    launchApp: "automation:window",
  })
}
