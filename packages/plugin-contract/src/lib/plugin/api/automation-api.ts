/**
 * The plugin contract's share of `lib/plugin/api/automation-api.ts`, which re-exports these.
 */
import type {
  ActionRequest,
  AppLocator,
  DragOpts,
  ElementHandle,
  GetAppStateOptions,
  Locator,
  MouseButton,
  Point,
  ScrollOpts,
} from "../../automation/action-schemas"
import type {
  ActionResult,
  ButtonTransition,
  Capabilities,
  ClickOpts,
  ClickTarget,
  ElementInfo,
  ElementRef,
  ExpandedElements,
  KeyChord,
  Rect,
  ResolvedApplication,
  Screenshot,
  ScreenshotOpts,
  ScrollTarget,
  TreeOpts,
  TypeOpts,
  UiStateRevision,
  UiTreeNode,
  WindowOp,
  ZoomedRegion,
} from "../../automation/types"
import type { FindScreenTextResult, ScreenTextMatch } from "../../automation/ocr-click"

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
  /**
   * The placement the originating send resolved — `PluginToolContext.sandboxRuntimeRef`,
   * forwarded verbatim. A send is bound once, so this ref, not whatever the
   * session happens to be bound to when the call lands, decides where the
   * desktop runs. Omit it only for callers with no send envelope.
   */
  sandboxRuntimeRef?: string
}
