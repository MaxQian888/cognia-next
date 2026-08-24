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

export type ArtifactRendererProfile = "diagram-design-v1"

/**
 * The subset worth remembering between sessions. `loading` is a property of
 * the preview that is on screen right now, not of the artifact — persisting it
 * would write on every render and leave a stale "loading" behind after a
 * reload — so only settled outcomes are recorded.
 */
export type SettledArtifactRuntimeHealth = Exclude<ArtifactRuntimeHealth, "loading">

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

/**
 * What every staged context selection carries: the text itself, a label for the
 * chip, and the user's comment on it.
 */
interface ContextSelectionBase {
  title: string
  snapshot: string
  comment: string
}

/**
 * A snippet selected inside an artifact, staged as a chat context chip. Carries
 * the selected text, the user's comment, and the line range, plus the owning
 * `artifactId` so the assistant's reply can route back into a review proposal
 * against that artifact. See `lib/artifacts/format-selection-context.ts`.
 *
 * **The only kind eligible to be the edit target.** A revision proposal needs
 * an artifact to diff against, so the other kinds below contribute context
 * only — see `ContextSelectionRef`.
 */
export interface ArtifactSelectionRef extends ContextSelectionBase {
  kind: "artifact"
  artifactId: string
  range: { startLine: number; endLine: number }
}

/** A file (or one diff hunk) handed over from the dock's workspace panel. */
export interface FileSelectionRef extends ContextSelectionBase {
  kind: "file"
  relPath: string
  /** Absent when the whole file was referenced rather than a range inside it. */
  range?: { startLine: number; endLine: number }
}

/** A review comment handed over from the workbench's comments panel. */
export interface CommentSelectionRef extends ContextSelectionBase {
  kind: "comment"
  /** What the comment hangs off, e.g. `"lines 12-18"`, for the prompt's benefit. */
  anchorLabel?: string
}

/** A page (or a selection inside one) handed over from the embedded browser. */
export interface WebSelectionRef extends ContextSelectionBase {
  kind: "web"
  url: string
}

/** Text captured from another desktop application via AX/UIA, OCR or clipboard fallback. */
export interface ExternalSelectionRef extends ContextSelectionBase {
  kind: "external"
  /** Native candidate identity used to make event consumption idempotent. */
  candidateId: string
  sourceApp: string
  sourceTitle?: string
  /**
   * How the text was obtained, and therefore how much to trust it. `ocr` means
   * it was read off the screen because the accessibility API exposed none, so
   * recognition errors are possible — the LLM context heading says so, and the
   * composer chip shows it.
   */
  origin: "accessibility" | "clipboard" | "ocr"
  truncated: boolean
}

/**
 * Something a plugin's own surface produced — a wiki page, a search hit, a
 * rendered report — staged from that plugin's panel.
 *
 * Deliberately *not* one variant per plugin. The host cannot know a plugin's
 * vocabulary, and a `kind: "wiki"` in this union would put one plugin's nouns
 * in the host's type system and force a recompile for the next one. What the
 * host does need is the same three things it needs from every other kind: what
 * to draw on the chip, how to head the prompt block, and where the excerpt came
 * from — so those are the fields, and everything else stays inside `ref`.
 */
export interface PluginSelectionRef extends ContextSelectionBase {
  kind: "plugin"
  /** Plugin that staged it; the chip attributes the excerpt to it. */
  pluginId: string
  /**
   * What the plugin calls this thing ("wiki page", "search result"). Goes into
   * the prompt heading verbatim, so it is English prompt scaffolding rather
   * than UI copy — the chip itself is localized around it.
   */
  sourceLabel: string
  /** The plugin's own address for the selection, echoed back on jump-to-source. */
  ref?: string
  /**
   * Where in the workspace the excerpt came from. This is the difference
   * between "the assistant was told some prose" and "the assistant can open the
   * code that prose is about".
   */
  citations?: Array<{ path: string; startLine?: number; endLine?: number }>
}

/**
 * Anything the user can stage as context for their next message.
 *
 * A discriminated union rather than four parallel staging arrays: the composer
 * already renders one chip per ref, folds them into the prompt on send, and
 * clears them afterwards — one pipeline, one chip bar, one formatter. The
 * discriminant is required, so adding a kind is a compile error at every place
 * that has to care rather than a silent fall-through to the artifact branch.
 */
export type ContextSelectionRef =
  | ArtifactSelectionRef
  | FileSelectionRef
  | CommentSelectionRef
  | WebSelectionRef
  | ExternalSelectionRef
  | PluginSelectionRef

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
  /**
   * Owning workspace id — Workspace isolation (Dexie v86). Stamped from the
   * active project on create. Undefined on pre-isolation artifacts, which stay
   * visible in every workspace (grandfathered) until re-saved.
   */
  projectId?: string
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
  /**
   * Namespaced descriptor for plugin-owned artifact payloads. The host treats
   * `kind` and `schemaVersion` as opaque routing/versioning data and enforces
   * `ownerPluginId` at the Plugin Artifact API boundary.
   */
  plugin?: {
    kind: string
    schemaVersion: number
    ownerPluginId: string
  }
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
  rendererProfile?: ArtifactRendererProfile

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
  /** Optional for compatibility with history rows persisted before title snapshots shipped. */
  title?: string
  content: string
  metadata?: ArtifactMetadata
  version: number
  createdAt: Date
  changeDescription?: string
}

// Canvas-specific types (OpenAI-style editing)
export type CanvasEditorNavigationSource =
  "cursor" | "outline" | "breadcrumb" | "direct" | "search" | "restore"

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
  "pending-review" | "completed" | "rejected" | "failed" | "invalidated"

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

/**
 * What the user did with an assistant-proposed revision, staged to be told to
 * the assistant on the next send.
 *
 * `accepted`/`total` rather than a bare verdict because partial acceptance is
 * the interesting case: "I took 2 of your 5 hunks" is a far more useful signal
 * than "applied", and without it the model cannot tell a wholesale agreement
 * from a grudging one.
 */
export interface ArtifactReviewReceipt {
  sessionId: string
  artifactId: string
  title: string
  outcome: "applied" | "rejected"
  /** Hunks the user kept. Always 0 for a rejection. */
  accepted: number
  /** Hunks the proposal contained. */
  total: number
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
  /** Owning workspace id — Workspace isolation (Dexie v86); stamped from the active project on create. */
  projectId?: string
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
  rendererProfile?: ArtifactRendererProfile
  content: string
  title: string
  startIndex: number
  endIndex: number
  lineCount: number
  confidence: number // 0-1, higher means more confident in detection
}
