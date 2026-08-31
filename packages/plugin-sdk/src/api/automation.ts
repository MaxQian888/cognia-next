/** Portable type surface for the governed `ctx.automation` namespace. */

export type { PluginAutomationAPI, PluginComputerUseOrigin } from "@/lib/plugin/api/automation-api"

export type {
  ActionRequest,
  ActionResult,
  AppLocator,
  AutomationError,
  ButtonTransition,
  Capabilities,
  ClickOpts,
  ClickTarget,
  DragOpts,
  ElementHandle,
  ElementInfo,
  ElementRef,
  EventFilter,
  EventKind,
  ExpandedElements,
  GetAppStateOptions,
  ImageFormat,
  KeyChord,
  Locator,
  MonitorInfo,
  MouseButton,
  PatternKind,
  Platform,
  Point,
  Rect,
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
  ZoomedRegion,
} from "@/lib/automation/types"

export type { FindScreenTextResult, ScreenTextMatch } from "@/lib/automation/ocr-click"

export type {
  UiaEventPayload,
  CallContext,
  Surface as AutomationSurface,
} from "@/lib/automation/client"

/**
 * Runtime zod schemas for the Computer Use action contract, plus the renderer
 * that turns one into the JSON Schema a `PluginTool.parametersSchema` expects.
 *
 * These are values, not types, because a plugin publishing computer-use tools
 * has to hand the host an actual JSON Schema. Exposing them here rather than
 * letting the plugin reach into `@/lib/automation/*` keeps the author boundary
 * intact (ADR-0155): the contract is re-exported deliberately instead of
 * crossed accidentally.
 */
export {
  actionRequestSchema,
  actionStrategySchema,
  actionTargetSchema,
  appLocatorSchema,
  dragOptsSchema,
  elementHandleSchema,
  elementRefSchema,
  getAppStateOptionsSchema,
  keyChordSchema,
  locatorSchema,
  mouseButtonSchema,
  pixelTargetSchema,
  pointSchema,
  scrollOptsSchema,
  toToolSchema,
  uiActionSchema,
  uiTreeProjectionKindSchema,
} from "@/lib/automation/action-schemas"

/**
 * Projection of a capture-bearing result into MCP content blocks.
 *
 * A plugin publishing computer-use tools has to return the frame as an image
 * block rather than as stringified base64, and the External Bridge has to
 * return the identical shape for the same revision. Sharing one projection is
 * what keeps the two model-facing surfaces from drifting apart.
 */
export {
  carriesFrame,
  frameToModelContent,
  screenshotMetadata,
  screenshotMimeType,
} from "@/lib/automation/model-frame"

export type { ModelContentBlock, ModelFrameResult } from "@/lib/automation/model-frame"
