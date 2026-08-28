/**
 * Plugin SDK - `canvas` capability runtime surface.
 *
 * Re-exports the host canvas API exposed as `ctx.canvas` and the companion
 * option/result types plugin authors need for document, action, comment, and
 * collaboration workflows.
 */

export { createCanvasAPI } from "@/lib/plugin/api/canvas-api"

export type {
  CanvasSelection,
  CreateCanvasDocumentOptions,
  PluginCanvasAPI,
  PluginCanvasDocument,
} from "@/types/plugin/plugin"

export type {
  CanvasActionConfig,
  CanvasActionExecutionOptions,
  CanvasActionResult,
  CanvasActionType,
  StreamingCallbacks,
} from "@/lib/ai/generation/canvas-actions"
export type { AddCommentInput, ReplyInput } from "@/lib/db/canvas-comments"
export type { PythonExecResult } from "@/lib/tauri/canvas"
export type { CanvasComment, CollaborativeSession } from "@/types/canvas/collaboration"
export type { ArtifactLanguage, CanvasDocumentVersion, CanvasSuggestion } from "@/types/artifact"

/** The artifact row itself — what `ctx.artifacts` stores and renders. */
export type { Artifact } from "@/types/artifact"
