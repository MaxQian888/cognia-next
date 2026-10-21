/**
 * Plugin SDK - `canvas` capability runtime surface.
 *
 * Exports the types of `ctx.canvas` and the companion option/result types
 * plugin authors need for document, action, comment, and collaboration
 * workflows. The host builds `ctx.canvas`; its factory is not on the author
 * surface.
 */

export type {
  CanvasSelection,
  CreateCanvasDocumentOptions,
  PluginCanvasAPI,
  PluginCanvasDocument,
} from "@cognia/plugin-contract/types/plugin/plugin"

export type {
  CanvasActionConfig,
  CanvasActionExecutionOptions,
  CanvasActionResult,
  CanvasActionType,
  StreamingCallbacks,
} from "@cognia/plugin-contract/lib/ai/generation/canvas-actions"
export type { AddCommentInput, ReplyInput } from "@cognia/plugin-contract/lib/db/canvas-comments"
export type { PythonExecResult } from "@cognia/plugin-contract/lib/tauri/canvas"
export type {
  CanvasComment,
  CollaborativeSession,
} from "@cognia/plugin-contract/types/canvas/collaboration"
export type {
  ArtifactLanguage,
  CanvasDocumentVersion,
  CanvasSuggestion,
} from "@cognia/plugin-contract/types/artifact/index"

/** The artifact row itself — what `ctx.artifacts` stores and renders. */
export type { Artifact } from "@cognia/plugin-contract/types/artifact/index"
