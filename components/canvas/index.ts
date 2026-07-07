/**
 * Canvas components barrel.
 *
 * Public API consumed by the desktop shell:
 *   - CanvasWorkspace (main right-pane container)
 *   - CanvasDocumentRail (replaces ChannelList in the canvas guild)
 *   - CanvasSidePanels (replaces MemberList in the canvas guild)
 *   - CanvasEmptyState (first-run state)
 *
 * The canvas-panel building blocks (suggestions, version history,
 * collaboration, comments, code execution) are exported for direct use
 * if/when the artifact store grows the matching surfaces.
 */

export { CanvasShell } from "./canvas-shell"
export { CanvasWorkspace } from "./canvas-workspace"
export { CanvasPanel } from "./canvas-panel"
export { CanvasDocumentRail } from "./canvas-document-rail"
export { CanvasSidePanels } from "./canvas-side-panels"
export { CanvasEmptyState } from "./canvas-empty-state"
export { CanvasErrorBoundary } from "./canvas-error-boundary"
export { CanvasDocumentTabs } from "./canvas-document-tabs"
export { CanvasDocumentList } from "./canvas-document-list"
export { VersionHistoryPanel } from "./version-history-panel"
export { VersionDiffView } from "./version-diff-view"
export { CodeExecutionPanel } from "./code-execution-panel"
export { SuggestionItem } from "./suggestion-item"
export { SuggestionsPanel } from "./suggestions-panel"
export { RenameDialog } from "./rename-dialog"
export { CollaborationPanel } from "./collaboration-panel"
export { CommentPanel } from "./comment-panel"
export { KeybindingSettings } from "./keybinding-settings"
export { CanvasPreviewPane } from "./canvas-preview-pane"
export { CanvasReviewView } from "./canvas-review-view"
export { CanvasViewModeToggle } from "./canvas-view-mode-toggle"
export { CanvasExportMenu } from "./canvas-export-menu"
export { CanvasLanguageSelect } from "./canvas-language-select"
export {
  CanvasOutlinePanel,
  parseCanvasSymbols,
  countCanvasSymbols,
  CANVAS_GOTO_LINE_EVENT,
} from "./canvas-outline-panel"
