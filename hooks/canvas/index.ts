/**
 * Canvas Hooks - React hooks for Canvas functionality
 */

export { useCanvasSuggestions } from "./use-canvas-suggestions"
export { useCodeExecution as useCanvasCodeExecution } from "./use-code-execution"
export { useCollaborativeSession } from "./use-collaborative-session"
export { useCanvasMonacoSetup } from "./use-canvas-monaco-setup"
export { useCanvasActions } from "./use-canvas-actions"
export { useCanvasKeyboardShortcuts } from "./use-canvas-keyboard-shortcuts"

export type { CodeSandboxExecutionResult, ExecutionOptions } from "./use-code-execution"
export type {
  SuggestionContext as CanvasSuggestionContext,
  GenerateSuggestionsOptions as CanvasGenerateSuggestionsOptions,
} from "./use-canvas-suggestions"
export type { UseCanvasKeyboardShortcutsOptions } from "./use-canvas-keyboard-shortcuts"
export type {
  UseCollaborativeSessionReturn,
  CollaborativeSessionConfig,
  CanvasCollaborationRuntimeState,
} from "./use-collaborative-session"
