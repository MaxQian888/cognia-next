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

import { desktop, type CallContext } from "@/lib/automation/client"
import { useChatStore } from "@/stores/chat"
import { getActiveComputerUseSettings } from "@/lib/claude/computer-use-active-settings"
import { captureScreenshot } from "@/lib/ui/screenshot"
import {
  HOST_FALLBACK_RUNTIME_REF,
  sandboxSessionRuntime,
  type SandboxRuntimeRef,
} from "@/lib/sandbox/session-runtime"
import { clickScreenText, findScreenText } from "@/lib/automation/ocr-click"
import {
  publishComputerUseActivity,
  publishComputerUsePipFrame,
} from "@/lib/automation/computer-use-pip"
import type { FindScreenTextResult, ScreenTextMatch } from "@/lib/automation/ocr-click"
import type {
  ActionRequest,
  ActionResult,
  AppLocator,
  ButtonTransition,
  Capabilities,
  ClickOpts,
  ClickTarget,
  DragOpts,
  ElementHandle,
  ElementInfo,
  ElementRef,
  ExpandedElements,
  GetAppStateOptions,
  KeyChord,
  Locator,
  MouseButton,
  Point,
  ResolvedApplication,
  Screenshot,
  ScreenshotOpts,
  ScrollOpts,
  ScrollTarget,
  TreeOpts,
  TypeOpts,
  UiStateRevision,
  UiTreeNode,
  WindowOp,
  Rect,
  ZoomedRegion,
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
  /** Ask the browser/WebView to share a display and return a PNG file. */
  captureDisplay(): Promise<File | null>

  // -------------------------------- app-session Computer Use (ADR-0020)
  /** List native apps available to the revision-bound Computer Use surface. */
  listApps(origin?: PluginComputerUseOrigin): Promise<ResolvedApplication[]>
  /** Read one app's accessibility tree and screenshot as a new revision. */
  getAppState(
    sessionId: string,
    locator: AppLocator,
    options?: GetAppStateOptions,
    origin?: PluginComputerUseOrigin
  ): Promise<UiStateRevision>
  /** Query elements from an already-read revision without taking another screenshot. */
  queryElements(
    state: Pick<UiStateRevision, "sessionId" | "lineageId" | "revision">,
    locator: Locator,
    limit?: number,
    origin?: PluginComputerUseOrigin
  ): Promise<UiTreeNode[]>
  /**
   * Crop the current revision's frame to one region, at the resolution it was
   * captured. Read-only, and gated exactly like the other capture-bearing
   * reads.
   */
  zoom(
    state: Pick<UiStateRevision, "sessionId" | "lineageId" | "revision">,
    region: Rect,
    origin?: PluginComputerUseOrigin
  ): Promise<ZoomedRegion>
  /** Expand one element from the current revision. */
  expandElement(
    handle: ElementHandle,
    continuationToken?: string | null,
    limit?: number,
    origin?: PluginComputerUseOrigin
  ): Promise<ExpandedElements>
  /** Execute one revision-bound native UI action. */
  performAction(request: ActionRequest, origin?: PluginComputerUseOrigin): Promise<ActionResult>

  /**
   * Locate on-screen text by OCR and report screen-space coordinates.
   *
   * The accessibility tree is the better instrument whenever it can see the
   * target, but it cannot see into a canvas, a game, a remote-desktop window
   * or a custom-drawn control. This is the fallback for exactly those, and it
   * is why the element-handle path alone is not sufficient coverage.
   */
  findText(
    args: { query?: string; languages?: string[]; opts?: ScreenshotOpts },
    origin?: PluginComputerUseOrigin
  ): Promise<FindScreenTextResult>
  /** Locate on-screen text by OCR and click the best match. */
  clickText(
    args: {
      query: string
      occurrence?: number
      button?: MouseButton
      doubleClick?: boolean
      languages?: string[]
      opts?: ScreenshotOpts
    },
    origin?: PluginComputerUseOrigin
  ): Promise<{ ok: true; clicked: ScreenTextMatch }>

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

/** Chat/runtime provenance used to scope consent and remote-desktop placement. */
export interface PluginComputerUseOrigin {
  sessionId?: string
  messageId?: string
}

interface AutomationRuntime {
  desktop: typeof desktop
  captureDisplay: typeof captureScreenshot
  getComputerUseSettings: typeof getActiveComputerUseSettings
  /** Focused chat session, used ONLY to scope consent — never placement. */
  focusedSessionId: () => string | undefined
  sandbox: Pick<
    typeof sandboxSessionRuntime,
    "activeRefForSession" | "decorateComputerUseContext"
  > & { hostFallbackRuntimeRef: SandboxRuntimeRef }
}

const defaultAutomationRuntime: AutomationRuntime = {
  desktop,
  captureDisplay: captureScreenshot,
  getComputerUseSettings: getActiveComputerUseSettings,
  focusedSessionId: () => useChatStore.getState().activeSessionId ?? undefined,
  sandbox: {
    hostFallbackRuntimeRef: HOST_FALLBACK_RUNTIME_REF,
    activeRefForSession: (sessionId) => sandboxSessionRuntime.activeRefForSession(sessionId),
    decorateComputerUseContext: (ref, base) =>
      sandboxSessionRuntime.decorateComputerUseContext(ref, base),
  },
}

async function buildComputerUseCallContext(
  pluginId: string,
  origin: PluginComputerUseOrigin | undefined,
  runtime: AutomationRuntime
): Promise<CallContext> {
  const context: CallContext = { surface: "computerUse", pluginId }
  // Consent scoping falls back to the focused session when the caller has no
  // session of its own (workflow node, plan step, External Bridge, a
  // plugin-to-plugin call). Without the fallback a character configured with
  // `requireConsent: true` silently loses the per-call overlay for exactly
  // those callers, because `forceTier` is only ever set from a session id.
  const focusedSessionId = runtime.focusedSessionId()
  const consentSessionId = origin?.sessionId ?? focusedSessionId
  if (consentSessionId) {
    context.sessionKey = consentSessionId
    // A plugin-provided session id is provenance, not authority: it may not be
    // used to LOWER the tier, so the focused session's stricter setting still
    // applies when the two disagree. It must not RAISE the tier either.
    // Treating the mere presence of an origin as a consent demand upgrades
    // every `Decision::Allow` to `RequireConsent`, which puts an approval
    // overlay in front of every step of a chat-driven run and makes the
    // Whitelist / Off tiers unreachable. Only `requireConsent` decides.
    if (
      runtime.getComputerUseSettings(consentSessionId)?.requireConsent === true ||
      (focusedSessionId !== consentSessionId &&
        runtime.getComputerUseSettings(focusedSessionId)?.requireConsent === true)
    ) {
      context.forceTier = "perCall"
    }
  }
  if (origin?.messageId) context.turnKey = origin.messageId

  // Placement deliberately does NOT take the focused-session fallback: it is
  // fine for scoping consent, but here it would borrow another conversation's
  // binding and drive the operator's own desktop for a session bound to a
  // remote target. Callers with no session keep the host/local placement.
  const runtimeRef =
    runtime.sandbox.activeRefForSession(origin?.sessionId) ?? runtime.sandbox.hostFallbackRuntimeRef
  return runtime.sandbox.decorateComputerUseContext(runtimeRef, context)
}

/**
 * Create the desktop Automation API for a plugin. Every call is tagged
 * `surface: "plugin"` + `pluginId` so the Rust gate runs the plugin policy;
 * the TS guard additionally requires the matching `automation:*` permission.
 */
/**
 * Report one automation call to the picture-in-picture live view.
 *
 * The PiP surface had no producer on this path at all: its only publishers
 * lived in the OCR fallback module, so during a real computer-use turn the
 * component mounted, saw no activity, and never appeared. The operator had no
 * live view of what the agent was doing to their machine.
 */
async function withPipActivity<T>(
  sessionKey: string | undefined,
  action: string,
  run: () => Promise<T>
): Promise<T> {
  const activityId = publishComputerUseActivity(sessionKey, action)
  try {
    const result = await run()
    publishComputerUseActivity(sessionKey, action, { ok: true }, activityId)
    return result
  } catch (error) {
    publishComputerUseActivity(
      sessionKey,
      action,
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      activityId
    )
    throw error
  }
}

/** Push a captured frame to the live view, skipping withheld (deduped) ones. */
function publishFrame(
  sessionKey: string | undefined,
  screenshot: { bytes: string; width: number; height: number; capturedAt?: number } | null
): void {
  if (!screenshot?.bytes) return
  publishComputerUsePipFrame(sessionKey, {
    output: screenshot.bytes,
    width: screenshot.width,
    height: screenshot.height,
    capturedAt: screenshot.capturedAt,
  })
}

export function createAutomationAPI(
  pluginId: string,
  runtime: AutomationRuntime = defaultAutomationRuntime
): PluginAutomationAPI {
  // The plugin never supplies the call context — we always stamp the plugin
  // surface + id so it can neither impersonate another surface nor drop its id.
  const ctx = { surface: "plugin", pluginId } as const

  const api: PluginAutomationAPI = {
    // read
    capabilities: () => runtime.desktop.capabilities(),
    getFocus: () => runtime.desktop.getFocus(ctx),
    readTree: (root = null, opts = {}) => runtime.desktop.readTree(root, opts, ctx),
    find: (locator) => runtime.desktop.find(locator, ctx),
    cursorPosition: () => runtime.desktop.cursorPosition(ctx),
    pickAtPoint: (point) => runtime.desktop.pickAtPoint(point, ctx),
    // screenshot
    screenshot: (opts = {}) => runtime.desktop.screenshot(opts, ctx),
    captureDisplay: () => runtime.captureDisplay(),
    listApps: async (origin) =>
      runtime.desktop.listApps(await buildComputerUseCallContext(pluginId, origin, runtime)),
    getAppState: async (sessionId, locator, options = {}, origin) => {
      const callCtx = await buildComputerUseCallContext(pluginId, origin, runtime)
      return withPipActivity(callCtx.sessionKey, "get_app_state", async () => {
        const revision = await runtime.desktop.getAppState(sessionId, locator, options, callCtx)
        publishFrame(callCtx.sessionKey, revision.screenshot)
        return revision
      })
    },
    queryElements: async (state, locator, limit = 100, origin) =>
      runtime.desktop.queryElements(
        state,
        locator,
        limit,
        await buildComputerUseCallContext(pluginId, origin, runtime)
      ),
    findText: async (args, origin) =>
      findScreenText({
        ...args,
        ctx: await buildComputerUseCallContext(pluginId, origin, runtime),
      }),
    clickText: async (args, origin) =>
      clickScreenText({
        ...args,
        ctx: await buildComputerUseCallContext(pluginId, origin, runtime),
      }),
    zoom: async (state, region, origin) => {
      const callCtx = await buildComputerUseCallContext(pluginId, origin, runtime)
      return withPipActivity(callCtx.sessionKey, "zoom", async () => {
        const zoomed = await runtime.desktop.zoom(state, region, callCtx)
        publishFrame(callCtx.sessionKey, zoomed.screenshot)
        return zoomed
      })
    },
    expandElement: async (handle, continuationToken = null, limit = 250, origin) =>
      runtime.desktop.expandElement(
        handle,
        continuationToken,
        limit,
        await buildComputerUseCallContext(pluginId, origin, runtime)
      ),
    performAction: async (request, origin) => {
      const callCtx = await buildComputerUseCallContext(pluginId, origin, runtime)
      return withPipActivity(callCtx.sessionKey, "perform_action", () =>
        runtime.desktop.performAction(request, callCtx)
      )
    },
    // click
    click: (target, opts = {}) => runtime.desktop.click(target, opts, ctx),
    mouseButton: (button, transition) => runtime.desktop.mouseButton(button, transition, ctx),
    // type
    type: (text, opts = {}) => runtime.desktop.type(text, opts, ctx),
    paste: (text) => runtime.desktop.paste(text, ctx),
    keys: (chord) => runtime.desktop.keys(chord, ctx),
    holdKey: (chord, durationMs) => runtime.desktop.holdKey(chord, durationMs, ctx),
    // pointer
    mouseMove: (point) => runtime.desktop.mouseMove(point, ctx),
    drag: (from, to, opts = {}) => runtime.desktop.drag(from, to, opts, ctx),
    scroll: (target, opts = {}) => runtime.desktop.scroll(target, opts, ctx),
    // window
    windowOp: (target, op) => runtime.desktop.windowOp(target, op, ctx),
    launchApp: (app, action) => runtime.desktop.launchApp(app, action, ctx),
  }

  return createGuardedAPI(pluginId, api, {
    capabilities: "automation:read",
    getFocus: "automation:read",
    readTree: "automation:read",
    find: "automation:read",
    cursorPosition: "automation:read",
    pickAtPoint: "automation:read",
    screenshot: "automation:screenshot",
    captureDisplay: "automation:screenshot",
    listApps: "automation:read",
    getAppState: ["automation:read", "automation:screenshot"],
    queryElements: "automation:read",
    // A zoom hands back screen pixels, so it needs the screenshot permission
    // even though it only re-crops a frame the caller has already been shown.
    zoom: ["automation:read", "automation:screenshot"],
    findText: ["automation:read", "automation:screenshot"],
    clickText: ["automation:read", "automation:screenshot", "automation:click"],
    expandElement: "automation:read",
    performAction: [
      "automation:click",
      "automation:type",
      "automation:pointer",
      "automation:window",
    ],
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
