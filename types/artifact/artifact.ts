/**
 * Artifact type definitions
 * Mirrors Claude/OpenAI Canvas artifacts: code, documents, and interactive
 * preview content (HTML / React / SVG / Mermaid / charts / math / Jupyter).
 *
 * Cognia's realtime collaboration types (`CanvasCollaboration*`) are dropped
 * from this port — cognia-next has no realtime backend yet. CanvasDocument /
 * CanvasDocumentVersion remain so the "Edit in Canvas" handoff still works.
 */

export type ArtifactType =
  | "code" // Code snippets (React, HTML, CSS, JS, Python, etc.)
  | "document" // Markdown documents
  | "svg" // SVG graphics
  | "html" // Full HTML pages
  | "react" // React components (for live preview)
  | "mermaid" // Mermaid diagrams
  | "chart" // Data visualizations
  | "math" // LaTeX math expressions
  | "jupyter" // Jupyter notebooks (.ipynb)

export type ArtifactLanguage =
  | "javascript"
  | "typescript"
  | "python"
  | "plaintext"
  | "html"
  | "css"
  | "json"
  | "markdown"
  | "jsx"
  | "tsx"
  | "sql"
  | "bash"
  | "yaml"
  | "xml"
  | "svg"
  | "mermaid"
  | "latex"

export type ArtifactRuntimeHealth = "ready" | "loading" | "error" | "unsupported"

export type ArtifactExportFormat = "raw" | "html" | "svg" | "png" | "pdf"

export type ArtifactWorkspaceScope = "session" | "recent"

export type ArtifactAuthoringOrigin =
  | "artifact-panel"
  | "artifact-panel-edit"
  | "artifact-embedded-designer"
  | "artifact-full-designer"
  | "canvas"

export interface ArtifactSourceRange {
  startIndex: number
  endIndex: number
}

export interface ArtifactWorkspaceReturnContext {
  scope: ArtifactWorkspaceScope
  sessionId?: string | null
  searchQuery: string
  typeFilter: ArtifactType | "all"
  runtimeFilter: ArtifactRuntimeHealth | "all"
  activeArtifactId?: string | null
  authoringOrigin?: ArtifactAuthoringOrigin
  workingRevisionUpdatedAt?: Date
}

export interface ArtifactWorkspaceState {
  scope: ArtifactWorkspaceScope
  sessionId?: string | null
  searchQuery: string
  typeFilter: ArtifactType | "all"
  runtimeFilter: ArtifactRuntimeHealth | "all"
  recentArtifactIds: string[]
  returnContext: ArtifactWorkspaceReturnContext | null
}

export interface Artifact {
  id: string
  sessionId: string
  messageId: string
  type: ArtifactType
  title: string
  content: string
  language?: ArtifactLanguage
  version: number
  createdAt: Date
  updatedAt: Date
  metadata?: ArtifactMetadata
}

export interface ArtifactMetadata {
  // For code artifacts
  runnable?: boolean
  dependencies?: string[]

  // For documents
  wordCount?: number

  // For charts
  chartType?: "line" | "bar" | "pie" | "doughnut" | "area" | "scatter"
  dataSource?: string

  // For HTML/React previews
  previewable?: boolean
  sandboxed?: boolean

  // For routed rich output
  outputProfileId?: string
  technology?: string
  hostStrategy?: string
  requestCategory?: string
  rolloutTier?: "core" | "advanced"
  widget?: {
    hostStrategy?: "native" | "artifact-preview" | "sandboxed-html" | "lazy-runtime"
    sizing?: "auto" | "content-height" | "fixed-height"
    theme?: "inherit" | "light" | "dark"
    status?: "ready" | "loading" | "fallback" | "error"
    showChrome?: boolean
    fallbackText?: string
    minHeight?: number
  }

  // Artifact workspace / detection metadata
  sourceOrigin?: "manual" | "auto" | "tool"
  sourceFingerprint?: string
  lineageId?: string
  derivedFromArtifactId?: string
  derivedFromVersionId?: number
  derivedFromCanvasDocumentId?: string
  sourceRange?: ArtifactSourceRange
  lastAccessedAt?: Date
  runtimeHealth?: ArtifactRuntimeHealth
  runtimeError?: string
  exportFormats?: ArtifactExportFormat[]
  userInitiated?: boolean
}

export interface ArtifactVersion {
  id: string
  artifactId: string
  content: string
  version: number
  createdAt: Date
  changeDescription?: string
}

// Canvas-specific types (OpenAI-style editing)
export type CanvasEditorNavigationSource =
  | "cursor"
  | "outline"
  | "breadcrumb"
  | "direct"
  | "search"
  | "restore"

export type CanvasDocumentSaveState = "saved" | "autosaved" | "dirty"

export type CanvasPerformanceMode = "standard" | "large" | "very-large"

export type CanvasWorkbenchActionType =
  | "custom"
  | "review"
  | "fix"
  | "improve"
  | "explain"
  | "simplify"
  | "expand"
  | "translate"
  | "format"
  | "run"

export type CanvasActionScope = "selection" | "document"

export type CanvasActionEntryPoint = "toolbar" | "inline" | "retry"

export type CanvasAttachmentSourceType = "canvas-document" | "artifact" | "session-message"

export type CanvasReviewItemStatus = "pending" | "accepted" | "rejected" | "invalidated"

export type CanvasReviewStatus = "pending" | "partial" | "completed" | "rejected" | "invalidated"

export type CanvasActionHistoryStatus =
  | "pending-review"
  | "completed"
  | "rejected"
  | "failed"
  | "invalidated"

export interface CanvasActionAttachment {
  id: string
  sourceType: CanvasAttachmentSourceType
  sourceId: string
  label: string
  snapshot: string
  isMissing?: boolean
  isTruncated?: boolean
}

export interface CanvasReviewDiffLine {
  type: "unchanged" | "added" | "removed"
  content: string
  lineNumber?: number
  newLineNumber?: number
}

export interface CanvasReviewLineRange {
  startLine: number
  endLine: number
}

export interface CanvasReviewItem {
  id: string
  actionType: CanvasWorkbenchActionType
  changeType: "replace" | "insert" | "delete"
  originalText: string
  proposedText: string
  status: CanvasReviewItemStatus
  range: CanvasReviewLineRange
  diffLines: CanvasReviewDiffLine[]
}

export interface CanvasPendingReview {
  id: string
  requestId: string
  actionType: CanvasWorkbenchActionType
  originalContent: string
  proposedContent: string
  createdAt: Date
  status: CanvasReviewStatus
  items: CanvasReviewItem[]
  isStale?: boolean
}

export interface CanvasActionHistoryEntry {
  id: string
  requestId: string
  actionType: CanvasWorkbenchActionType
  prompt: string
  scope: CanvasActionScope
  entryPoint: CanvasActionEntryPoint
  createdAt: Date
  status: CanvasActionHistoryStatus
  attachmentSummary: string[]
  attachments?: CanvasActionAttachment[]
  reviewId?: string
  error?: string
  lineageId?: string
}

export interface CanvasAIWorkbenchState {
  promptDraft: string
  selectedPresetAction: CanvasWorkbenchActionType | null
  attachments: CanvasActionAttachment[]
  pendingReview: CanvasPendingReview | null
  actionHistory: CanvasActionHistoryEntry[]
  isInlineCommandOpen: boolean
}

export interface CanvasEditorSelection {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export interface CanvasEditorVisibleRange {
  startLineNumber: number
  endLineNumber: number
  scrollTop?: number
  scrollLeft?: number
}

export interface CanvasEditorLocation {
  source: CanvasEditorNavigationSource
  path: string[]
  lineNumber: number
  column: number
  symbolName?: string
}

export interface CanvasEditorContext {
  cursorLine?: number
  cursorColumn?: number
  selection?: CanvasEditorSelection | null
  visibleRange?: CanvasEditorVisibleRange | null
  location?: CanvasEditorLocation | null
  lastSavedAt?: Date
  lastRestoredAt?: Date
  saveState?: CanvasDocumentSaveState
  performanceMode?: CanvasPerformanceMode
}

export interface CanvasDocument {
  id: string
  sessionId: string
  title: string
  content: string
  language: ArtifactLanguage
  type: "code" | "text"
  createdAt: Date
  updatedAt: Date
  sourceArtifactId?: string
  returnContext?: ArtifactWorkspaceReturnContext | null
  authoringOrigin?: ArtifactAuthoringOrigin
  editorContext?: CanvasEditorContext
  aiWorkbench?: CanvasAIWorkbenchState
  aiSuggestions?: CanvasSuggestion[]
  versions?: CanvasDocumentVersion[]
  currentVersionId?: string
}

export interface CanvasDocumentVersion {
  id: string
  content: string
  title: string
  createdAt: Date
  description?: string
  isAutoSave?: boolean
}

export interface CanvasSuggestion {
  id: string
  type: "edit" | "comment" | "fix" | "improve"
  range: {
    startLine: number
    endLine: number
    startColumn?: number
    endColumn?: number
  }
  originalText: string
  suggestedText: string
  explanation: string
  status: "pending" | "accepted" | "rejected"
}

export interface CanvasAction {
  type:
    | "review"
    | "fix"
    | "explain"
    | "improve"
    | "translate"
    | "simplify"
    | "expand"
    | "format"
    | "run"
  label: string
  icon: string
  shortcut?: string
}

// Analysis tool types
export interface AnalysisResult {
  id: string
  sessionId: string
  messageId: string
  type: "math" | "chart" | "data"
  content: string
  output?: AnalysisOutput
  createdAt: Date
}

export interface AnalysisOutput {
  // Math results
  latex?: string
  result?: string | number

  // Chart data
  chartConfig?: {
    type: "line" | "bar" | "pie" | "area" | "scatter" | "radar"
    data: ChartDataPoint[]
    options?: Record<string, unknown>
  }

  // Data analysis
  summary?: string
  statistics?: Record<string, number>
}

export interface ChartDataPoint {
  name: string
  value: number
  [key: string]: string | number
}

// Jupyter Notebook Types
export interface JupyterOutput {
  output_type: "stream" | "display_data" | "execute_result" | "error"
  name?: string // stdout, stderr for stream
  text?: string | string[]
  data?: Record<string, unknown> // MIME type to content
  execution_count?: number | null
  ename?: string // error name
  evalue?: string // error value
  traceback?: string[] // error traceback
}

export interface JupyterCell {
  cell_type: "code" | "markdown" | "raw"
  source: string | string[]
  outputs?: JupyterOutput[]
  execution_count?: number | null
  metadata?: Record<string, unknown>
  id?: string
}

export interface JupyterNotebook {
  cells: JupyterCell[]
  metadata: {
    kernelspec?: {
      name: string
      language: string
      display_name: string
    }
    language_info?: {
      name: string
      version?: string
    }
  }
  nbformat: number
  nbformat_minor: number
}

// Sandbox Execution Types
export type SandboxType = "pyodide" | "tauri" | "webcontainer" | "iframe"

export interface ArtifactExecutionResult {
  success: boolean
  stdout: string
  stderr: string
  result?: unknown
  error?: string
  executionTime?: number // milliseconds
  outputs?: JupyterOutput[]
}

export interface ArtifactSandboxConfig {
  type: SandboxType
  timeout?: number // milliseconds
  packages?: string[] // for pyodide/webcontainer
  workingDirectory?: string // for tauri
}

// Auto-Detection Config Types
export interface ArtifactDetectionConfig {
  /** Minimum lines for auto-trigger (default: 10) */
  minLines: number
  /** Whether to auto-create artifacts */
  autoCreate: boolean
  /** Content types to auto-detect */
  enabledTypes: ArtifactType[]
  /** Whether to show notification when artifact is created */
  showNotification: boolean
}

export interface DetectedArtifact {
  type: ArtifactType
  language?: ArtifactLanguage
  content: string
  title: string
  startIndex: number
  endIndex: number
  lineCount: number
  confidence: number // 0-1, higher means more confident in detection
}
