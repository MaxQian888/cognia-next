/**
 * Extended Plugin SDK Types
 *
 * Additional API interfaces for the enhanced plugin system.
 * These extend the base plugin types with deeper integration capabilities.
 */

import type {
  Session,
  CreateSessionInput,
  UpdateSessionInput,
  UIMessage,
  Project,
  CreateProjectInput,
  UpdateProjectInput,
  KnowledgeFile,
  ChatMode,
} from "./_compat"
import type { Artifact, ArtifactLanguage } from "../artifact/artifact"
import type { CanvasDocumentVersion, CanvasSuggestion } from "../artifact/artifact"
// PluginMediaAPI and CanonicalExtensionPoint live in `lib/plugin/api/media-api`
// and `lib/plugin/contracts/plugin-points` respectively; those modules are
// added by Phase 2 / Task #10. We mark `PluginMediaAPI` as an opaque object
// type rather than a `Record<string, unknown>` so the real media API type
// (with named methods, no index signature) can be assigned to it without
// the structural mismatch flagged by TS2322.
type PluginMediaAPI = object
type CanonicalExtensionPoint = string

// =============================================================================
// Session API - Chat Session Management
// =============================================================================

/**
 * Filter options for listing sessions
 */
export interface SessionFilter {
  projectId?: string
  mode?: ChatMode
  hasMessages?: boolean
  createdAfter?: Date
  createdBefore?: Date
  limit?: number
  offset?: number
  sortBy?: "createdAt" | "updatedAt" | "title"
  sortOrder?: "asc" | "desc"
}

/**
 * Options for querying messages
 */
export interface MessageQueryOptions {
  limit?: number
  offset?: number
  branchId?: string
  includeDeleted?: boolean
  afterId?: string
  beforeId?: string
}

/**
 * Options for sending messages
 */
export interface SendMessageOptions {
  role?: "user" | "assistant" | "system"
  attachments?: MessageAttachment[]
  metadata?: Record<string, unknown>
  skipProcessing?: boolean
}

/**
 * Message attachment for plugin use
 */
export interface MessageAttachment {
  type: "file" | "image" | "code" | "url"
  name: string
  content?: string
  url?: string
  mimeType?: string
  size?: number
}

/**
 * Session API for plugins
 */
export interface PluginSessionAPI {
  /** Get the currently active session */
  getCurrentSession: () => Session | null

  /** Get the current session ID */
  getCurrentSessionId: () => string | null

  /** Get a session by ID */
  getSession: (id: string) => Promise<Session | null>

  /** Create a new session */
  createSession: (options?: CreateSessionInput) => Promise<Session>

  /** Update a session */
  updateSession: (id: string, updates: UpdateSessionInput) => Promise<void>

  /** Switch to a different session */
  switchSession: (id: string) => Promise<void>

  /** Delete a session */
  deleteSession: (id: string) => Promise<void>

  /** List sessions with optional filtering */
  listSessions: (filter?: SessionFilter) => Promise<Session[]>

  /** Get messages for a session */
  getMessages: (sessionId: string, options?: MessageQueryOptions) => Promise<UIMessage[]>

  /** Add a message to a session */
  addMessage: (
    sessionId: string,
    content: string,
    options?: SendMessageOptions
  ) => Promise<UIMessage>

  /** Update a message */
  updateMessage: (
    sessionId: string,
    messageId: string,
    updates: Partial<UIMessage>
  ) => Promise<void>

  /** Delete a message */
  deleteMessage: (sessionId: string, messageId: string) => Promise<void>

  /** Subscribe to session changes */
  onSessionChange: (handler: (session: Session | null) => void) => () => void

  /** Subscribe to message changes in a session */
  onMessagesChange: (sessionId: string, handler: (messages: UIMessage[]) => void) => () => void

  /** Get session statistics */
  getSessionStats: (sessionId: string) => Promise<SessionStats>
}

/**
 * Session statistics
 */
export interface SessionStats {
  messageCount: number
  userMessageCount: number
  assistantMessageCount: number
  totalTokens: number
  averageResponseTime: number
  branchCount: number
  attachmentCount: number
}

// =============================================================================
// Project API - Project Management
// =============================================================================

/**
 * Filter options for listing projects
 */
export interface ProjectFilter {
  isArchived?: boolean
  tags?: string[]
  createdAfter?: Date
  createdBefore?: Date
  limit?: number
  offset?: number
  sortBy?: "createdAt" | "updatedAt" | "lastAccessedAt" | "name"
  sortOrder?: "asc" | "desc"
}

/**
 * Project file input for adding to knowledge base
 */
export interface ProjectFileInput {
  name: string
  content: string
  type?: KnowledgeFile["type"]
  mimeType?: string
}

/**
 * Project API for plugins
 */
export interface PluginProjectAPI {
  /** Get the currently active project */
  getCurrentProject: () => Project | null

  /** Get the current project ID */
  getCurrentProjectId: () => string | null

  /** Get a project by ID */
  getProject: (id: string) => Promise<Project | null>

  /** Create a new project */
  createProject: (options: CreateProjectInput) => Promise<Project>

  /** Update a project */
  updateProject: (id: string, updates: UpdateProjectInput) => Promise<void>

  /** Delete a project */
  deleteProject: (id: string) => Promise<void>

  /** Set the active project */
  setActiveProject: (id: string | null) => Promise<void>

  /** List projects with optional filtering */
  listProjects: (filter?: ProjectFilter) => Promise<Project[]>

  /** Archive a project */
  archiveProject: (id: string) => Promise<void>

  /** Unarchive a project */
  unarchiveProject: (id: string) => Promise<void>

  /** Add a file to project knowledge base */
  addKnowledgeFile: (projectId: string, file: ProjectFileInput) => Promise<KnowledgeFile>

  /** Remove a file from project knowledge base */
  removeKnowledgeFile: (projectId: string, fileId: string) => Promise<void>

  /** Update a knowledge file */
  updateKnowledgeFile: (projectId: string, fileId: string, content: string) => Promise<void>

  /** Get all knowledge files for a project */
  getKnowledgeFiles: (projectId: string) => Promise<KnowledgeFile[]>

  /** Link a session to a project */
  linkSession: (projectId: string, sessionId: string) => Promise<void>

  /** Unlink a session from a project */
  unlinkSession: (projectId: string, sessionId: string) => Promise<void>

  /** Get all sessions for a project */
  getProjectSessions: (projectId: string) => Promise<string[]>

  /** Subscribe to project changes */
  onProjectChange: (handler: (project: Project | null) => void) => () => void

  /** Add a tag to a project */
  addTag: (projectId: string, tag: string) => Promise<void>

  /** Remove a tag from a project */
  removeTag: (projectId: string, tag: string) => Promise<void>
}

// =============================================================================
// Vector/RAG API - Semantic Search and Retrieval
// =============================================================================

/**
 * Vector document for storage
 */
export interface VectorDocument {
  id?: string
  content: string
  metadata?: Record<string, unknown>
  embedding?: number[]
}

/**
 * Vector search options
 */
export interface VectorSearchOptions {
  topK?: number
  threshold?: number
  filters?: VectorFilter[]
  filterMode?: "and" | "or"
  includeMetadata?: boolean
  includeEmbeddings?: boolean
}

/**
 * Vector filter for search
 */
export interface VectorFilter {
  key: string
  value: string | number | boolean
  operation: "eq" | "ne" | "gt" | "lt" | "gte" | "lte" | "contains" | "in"
}

/**
 * Vector search result
 */
export interface VectorSearchResult {
  id: string
  content: string
  metadata?: Record<string, unknown>
  score: number
  embedding?: number[]
}

/**
 * Collection options for vector store
 */
export interface CollectionOptions {
  embeddingModel?: string
  dimensions?: number
  metadata?: Record<string, unknown>
}

/**
 * Collection statistics
 */
export interface CollectionStats {
  name: string
  documentCount: number
  dimensions: number
  createdAt: Date
  lastUpdated: Date
  sizeBytes?: number
}

/**
 * Vector/RAG API for plugins
 */
export interface PluginVectorAPI {
  /** Create a new collection */
  createCollection: (name: string, options?: CollectionOptions) => Promise<string>

  /** Delete a collection */
  deleteCollection: (name: string) => Promise<void>

  /** List all collections */
  listCollections: () => Promise<string[]>

  /** Get collection info */
  getCollectionInfo: (name: string) => Promise<CollectionStats>

  /** Add documents to a collection */
  addDocuments: (collection: string, docs: VectorDocument[]) => Promise<string[]>

  /** Update documents in a collection */
  updateDocuments: (collection: string, docs: VectorDocument[]) => Promise<void>

  /** Delete documents from a collection */
  deleteDocuments: (collection: string, ids: string[]) => Promise<void>

  /** Search documents in a collection */
  search: (
    collection: string,
    query: string,
    options?: VectorSearchOptions
  ) => Promise<VectorSearchResult[]>

  /** Search with a pre-computed embedding */
  searchByEmbedding: (
    collection: string,
    embedding: number[],
    options?: VectorSearchOptions
  ) => Promise<VectorSearchResult[]>

  /** Generate embedding for text */
  embed: (text: string) => Promise<number[]>

  /** Generate embeddings for multiple texts */
  embedBatch: (texts: string[]) => Promise<number[][]>

  /** Get document count in a collection */
  getDocumentCount: (collection: string) => Promise<number>

  /** Clear all documents in a collection */
  clearCollection: (collection: string) => Promise<void>
}

// =============================================================================
// Theme API - Appearance Customization
// =============================================================================

/**
 * Theme mode
 */
export type ThemeMode = "light" | "dark" | "system"

/**
 * Color theme preset
 */
export type ColorThemePreset =
  | "default"
  | "ocean"
  | "forest"
  | "sunset"
  | "lavender"
  | "rose"
  | "slate"
  | "amber"

/**
 * Theme colors structure
 */
export interface ThemeColors {
  primary: string
  primaryForeground: string
  secondary: string
  secondaryForeground: string
  accent: string
  accentForeground: string
  background: string
  foreground: string
  muted: string
  mutedForeground: string
  card: string
  cardForeground: string
  popover: string
  popoverForeground: string
  input: string
  border: string
  ring: string
  destructive: string
  destructiveForeground: string
  sidebar: string
  sidebarForeground: string
  sidebarPrimary: string
  sidebarBorder: string
  sidebarPrimaryForeground: string
  sidebarAccent: string
  sidebarAccentForeground: string
  sidebarRing: string
}

/**
 * Custom theme definition.
 *
 * Phase 2 of the theme/background fix introduced a dual-variant shape:
 * a saved theme now carries both `tokens.light` and `tokens.dark` so the
 * runtime can render the right palette regardless of which side the
 * `next-themes` resolver lands on. The legacy `colors`/`isDark` fields
 * are retained one release for migration safety — Task 8 ships the
 * Dexie v16 migration that fills `tokens` for older rows.
 */
export interface CustomTheme {
  id: string
  name: string

  // ----- New dual-variant fields (Phase 2) -----
  /** User's original variant intent — drives default light/dark when activated. */
  baseVariant?: "light" | "dark"
  /** Both variant palettes. The `derivedVariant` was filled by the algorithm. */
  tokens?: { light: ThemeColors; dark: ThemeColors }
  /**
   * Marks which side was auto-derived (vs hand-edited or imported).
   * Set by the v16 migration (Task 8) when promoting legacy rows, and by the
   * VSCode import path (Task 9) when one variant is filled by deriveOppositeVariant.
   */
  derivedVariant?: "light" | "dark"

  // ----- Legacy single-set fields (kept one release for migration safety) -----
  /** @deprecated Read via `tokens` instead. Retained for pre-v16 rows. */
  colors?: Partial<ThemeColors>
  /** @deprecated Read via `baseVariant` instead. Retained for pre-v16 rows. */
  isDark?: boolean
}

/**
 * Current theme state
 */
export interface ThemeState {
  mode: ThemeMode
  resolvedMode: "light" | "dark"
  colorPreset: ColorThemePreset
  customThemeId: string | null
  themeSource?: "preset" | "custom"
  colors: ThemeColors
}

/**
 * Theme API for plugins
 */
export interface PluginThemeAPI {
  /** Get current theme state */
  getTheme: () => ThemeState

  /** Get current theme mode */
  getMode: () => ThemeMode

  /** Get resolved theme mode (light or dark) */
  getResolvedMode: () => "light" | "dark"

  /** Set theme mode */
  setMode: (mode: ThemeMode) => void

  /** Get current color preset */
  getColorPreset: () => ColorThemePreset

  /** Set color preset */
  setColorPreset: (preset: ColorThemePreset) => void

  /** Get all color presets */
  getAvailablePresets: () => ColorThemePreset[]

  /** Get current theme colors */
  getColors: () => ThemeColors

  /** Register a custom theme */
  registerCustomTheme: (theme: Omit<CustomTheme, "id">) => string

  /** Update a custom theme */
  updateCustomTheme: (id: string, updates: Partial<CustomTheme>) => void

  /** Delete a custom theme */
  deleteCustomTheme: (id: string) => void

  /** Get all custom themes */
  getCustomThemes: () => CustomTheme[]

  /** Activate a custom theme */
  activateCustomTheme: (id: string) => void

  /** Subscribe to theme changes */
  onThemeChange: (handler: (theme: ThemeState) => void) => () => void

  /** Apply CSS variables for a component (scoped styling) */
  applyScopedColors: (element: HTMLElement, colors: Partial<ThemeColors>) => () => void
}

// =============================================================================
// Export API - Data Export
// =============================================================================

/**
 * Export format types
 */
export type ExportFormat =
  | "markdown"
  | "json"
  | "html"
  | "animated-html"
  | "pdf"
  | "text"
  | "docx"
  | "csv"

/**
 * Export options
 */
export interface ExportOptions {
  format: ExportFormat
  theme?: "light" | "dark" | "system"
  showTimestamps?: boolean
  showTokens?: boolean
  showThinkingProcess?: boolean
  showToolCalls?: boolean
  includeMetadata?: boolean
  includeAttachments?: boolean
  includeCoverPage?: boolean
  includeTableOfContents?: boolean
}

/**
 * Custom exporter definition
 */
export interface CustomExporter {
  id: string
  name: string
  description: string
  format: string
  extension: string
  mimeType: string
  export: (data: ExportData) => Promise<Blob | string>
}

/**
 * Export data payload
 */
export interface ExportData {
  session?: Session
  messages?: UIMessage[]
  project?: Project
  exportedAt: Date
  metadata?: Record<string, unknown>
}

/**
 * Export result
 */
export interface ExportResult {
  success: boolean
  blob?: Blob
  filename?: string
  error?: string
}

/**
 * Export API for plugins
 */
export interface PluginExportAPI {
  /** Export a session */
  exportSession: (sessionId: string, options: ExportOptions) => Promise<ExportResult>

  /** Export a project */
  exportProject: (projectId: string, options: ExportOptions) => Promise<ExportResult>

  /** Export messages */
  exportMessages: (messages: UIMessage[], options: ExportOptions) => Promise<ExportResult>

  /** Download an export result */
  download: (result: ExportResult, filename?: string) => void

  /** Register a custom exporter */
  registerExporter: (exporter: CustomExporter) => () => void

  /** Get available export formats */
  getAvailableFormats: () => ExportFormat[]

  /** Get custom exporters */
  getCustomExporters: () => CustomExporter[]

  /** Generate filename for export */
  generateFilename: (title: string, extension: string) => string
}

// =============================================================================
// I18n API - Internationalization
// =============================================================================

/**
 * Supported locales
 */
export type Locale = "en" | "zh-CN"

/**
 * Translation parameters
 */
export type TranslationParams = Record<string, string | number | boolean>

/**
 * I18n API for plugins
 */
export interface PluginI18nAPI {
  /** Get current locale */
  getCurrentLocale: () => Locale

  /** Get available locales */
  getAvailableLocales: () => Locale[]

  /** Get locale display name */
  getLocaleName: (locale: Locale) => string

  /** Translate a key */
  t: (key: string, params?: TranslationParams) => string

  /** Register plugin translations */
  registerTranslations: (locale: Locale, translations: Record<string, string>) => void

  /** Check if a translation key exists */
  hasTranslation: (key: string) => boolean

  /** Subscribe to locale changes */
  onLocaleChange: (handler: (locale: Locale) => void) => () => void

  /** Format date according to locale */
  formatDate: (date: Date, options?: Intl.DateTimeFormatOptions) => string

  /** Format number according to locale */
  formatNumber: (number: number, options?: Intl.NumberFormatOptions) => string

  /** Format relative time */
  formatRelativeTime: (date: Date) => string
}

// =============================================================================
// Canvas API - Document Editing
// =============================================================================

/**
 * Canvas document for editing
 */
export interface PluginCanvasDocument {
  id: string
  sessionId: string
  title: string
  content: string
  language: ArtifactLanguage
  type: "code" | "text"
  createdAt: Date
  updatedAt: Date
  suggestions?: CanvasSuggestion[]
  versions?: CanvasDocumentVersion[]
}

/**
 * Canvas document creation options
 */
export interface CreateCanvasDocumentOptions {
  sessionId?: string
  title: string
  content: string
  language: ArtifactLanguage
  type: "code" | "text"
}

/**
 * Canvas selection
 */
export interface CanvasSelection {
  start: number
  end: number
  text: string
}

/**
 * Canvas API for plugins
 */
export interface PluginCanvasAPI {
  /** Get current canvas document */
  getCurrentDocument: () => PluginCanvasDocument | null

  /** Get a canvas document by ID */
  getDocument: (id: string) => PluginCanvasDocument | null

  /** Create a new canvas document */
  createDocument: (options: CreateCanvasDocumentOptions) => Promise<string>

  /** Update a canvas document */
  updateDocument: (id: string, updates: Partial<PluginCanvasDocument>) => void

  /** Delete a canvas document */
  deleteDocument: (id: string) => void

  /** Open a canvas document */
  openDocument: (id: string) => void

  /** Close the canvas panel */
  closeCanvas: () => void

  /** Get current selection in canvas */
  getSelection: () => CanvasSelection | null

  /** Set selection in canvas */
  setSelection: (start: number, end: number) => void

  /** Insert text at cursor position */
  insertText: (text: string) => void

  /** Replace selected text */
  replaceSelection: (text: string) => void

  /** Get document content */
  getContent: (id?: string) => string

  /** Set document content */
  setContent: (content: string, id?: string) => void

  /** Save a version of the document */
  saveVersion: (id: string, description?: string) => Promise<string>

  /** Restore a version */
  restoreVersion: (documentId: string, versionId: string) => void

  /** Get all versions of a document */
  getVersions: (id: string) => CanvasDocumentVersion[]

  /** Subscribe to canvas changes */
  onCanvasChange: (handler: (doc: PluginCanvasDocument | null) => void) => () => void

  /** Subscribe to content changes */
  onContentChange: (handler: (content: string) => void) => () => void
}

// =============================================================================
// Artifact API - Artifact Management
// =============================================================================

/**
 * Artifact creation options
 */
export interface CreateArtifactOptions {
  title: string
  content: string
  language: ArtifactLanguage
  sessionId?: string
  messageId?: string
  type?: "code" | "text" | "react" | "html" | "svg" | "mermaid"
  metadata?: Artifact["metadata"]
}

/**
 * Artifact filter options
 */
export interface ArtifactFilter {
  sessionId?: string
  language?: ArtifactLanguage
  type?: string
  limit?: number
  offset?: number
}

/**
 * Artifact API for plugins
 */
export interface PluginArtifactAPI {
  /** Get active artifact */
  getActiveArtifact: () => Artifact | null

  /** Get an artifact by ID */
  getArtifact: (id: string) => Artifact | null

  /** Create a new artifact */
  createArtifact: (options: CreateArtifactOptions) => Promise<string>

  /** Update an artifact */
  updateArtifact: (id: string, updates: Partial<Artifact>) => void

  /** Delete an artifact */
  deleteArtifact: (id: string) => void

  /** List artifacts */
  listArtifacts: (filter?: ArtifactFilter) => Artifact[]

  /** Open artifact panel with specific artifact */
  openArtifact: (id: string) => void

  /** Close artifact panel */
  closeArtifact: () => void

  /** Subscribe to artifact changes */
  onArtifactChange: (handler: (artifact: Artifact | null) => void) => () => void

  /** Register a custom artifact renderer */
  registerRenderer: (type: string, renderer: ArtifactRenderer) => () => void
}

/**
 * Artifact renderer definition
 */
export interface ArtifactRenderer {
  type: string
  name: string
  canRender: (artifact: Artifact) => boolean
  render: (artifact: Artifact, container: HTMLElement) => () => void
}

// =============================================================================
// Notification Center API
// =============================================================================

/**
 * Notification options
 */
export interface NotificationOptions {
  title: string
  message: string
  type?: "info" | "success" | "warning" | "error"
  duration?: number
  icon?: string
  actions?: NotificationAction[]
  persistent?: boolean
  progress?: number
}

/**
 * Notification action
 */
export interface NotificationAction {
  label: string
  action: string
  variant?: "default" | "primary" | "destructive"
}

/**
 * Notification instance
 */
export interface Notification {
  id: string
  title: string
  message: string
  type: "info" | "success" | "warning" | "error"
  createdAt: Date
  actions?: NotificationAction[]
  progress?: number
  persistent: boolean
}

/**
 * Notification Center API for plugins
 */
export interface PluginNotificationCenterAPI {
  /** Create a notification */
  create: (options: NotificationOptions) => string

  /** Update a notification */
  update: (id: string, updates: Partial<NotificationOptions>) => void

  /** Dismiss a notification */
  dismiss: (id: string) => void

  /** Dismiss all notifications */
  dismissAll: () => void

  /** Get all active notifications */
  getAll: () => Notification[]

  /** Subscribe to notification actions */
  onAction: (handler: (id: string, action: string) => void) => () => void

  /** Create a progress notification */
  createProgress: (
    title: string,
    message: string
  ) => {
    id: string
    update: (progress: number, message?: string) => void
    complete: (message?: string) => void
    error: (message: string) => void
  }
}

// =============================================================================
// Storage API - Per-plugin persistent key-value storage
// =============================================================================

/**
 * Per-plugin persistent storage API
 *
 * Each plugin gets an isolated key-value namespace backed by localStorage.
 * Storage is limited to 5MB per plugin.
 */
export interface PluginStorageAPI {
  /** Get a value by key */
  get<T = unknown>(key: string): Promise<T | undefined>
  /** Get a value by key with a default */
  getOrDefault<T = unknown>(key: string, defaultValue: T): Promise<T>
  /** Set a value by key */
  set<T = unknown>(key: string, value: T): Promise<void>
  /** Remove a value by key */
  remove(key: string): Promise<void>
  /** Delete alias for compatibility with legacy PluginStorage */
  delete(key: string): Promise<void>
  /** Check if a key exists */
  has(key: string): Promise<boolean>
  /** Get all keys in this plugin's namespace */
  keys(): Promise<string[]>
  /** Clear all plugin storage */
  clear(): Promise<void>
  /** Get storage usage in bytes (approximate) */
  getUsage(): Promise<number>
}

// =============================================================================
// AI Provider API - Custom AI Providers
// =============================================================================

/**
 * Chat message for AI
 */
export interface AIChatMessage {
  role: "user" | "assistant" | "system"
  content: string
  name?: string
}

/**
 * Chat options
 */
export interface AIChatOptions {
  model?: string
  temperature?: number
  maxTokens?: number
  topP?: number
  stop?: string[]
  stream?: boolean
}

/**
 * Chat response chunk
 */
export interface AIChatChunk {
  content: string
  finishReason?: "stop" | "length" | "tool_calls"
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

/**
 * AI model definition
 */
export interface AIModel {
  id: string
  name: string
  provider: string
  contextLength: number
  capabilities: ("chat" | "completion" | "embedding" | "vision" | "function_calling")[]
}

/**
 * Custom AI provider definition
 */
export interface AIProviderDefinition {
  id: string
  name: string
  description: string
  icon?: string
  models: AIModel[]
  chat: (messages: AIChatMessage[], options?: AIChatOptions) => AsyncIterable<AIChatChunk>
  embed?: (texts: string[]) => Promise<number[][]>
  validateApiKey?: (apiKey: string) => Promise<boolean>
}

/**
 * AI Provider API for plugins
 */
export interface PluginAIProviderAPI {
  /** Register a custom AI provider */
  registerProvider: (provider: AIProviderDefinition) => () => void

  /** Get available models */
  getAvailableModels: () => AIModel[]

  /** Get models for a specific provider */
  getProviderModels: (providerId: string) => AIModel[]

  /** Chat with a model */
  chat: (messages: AIChatMessage[], options?: AIChatOptions) => AsyncIterable<AIChatChunk>

  /** Generate embeddings */
  embed: (texts: string[]) => Promise<number[][]>

  /** Get current default model */
  getDefaultModel: () => string

  /** Get current default provider */
  getDefaultProvider: () => string
}

// =============================================================================
// Extension Points API - UI Extensions
// =============================================================================

/**
 * UI extension points
 */
export type ExtensionPoint = CanonicalExtensionPoint

/**
 * Extension options
 */
export interface ExtensionOptions {
  priority?: number
  condition?: () => boolean
}

/**
 * Extension registration
 */
export interface ExtensionRegistration {
  id: string
  pluginId: string
  point: ExtensionPoint
  component: React.ComponentType<ExtensionProps>
  options: ExtensionOptions
}

/**
 * Props passed to extension components
 */
export interface ExtensionProps {
  pluginId: string
  extensionId: string
}

/**
 * Extension Points API for plugins
 */
export interface PluginExtensionAPI {
  /** Register a UI extension */
  registerExtension: (
    point: ExtensionPoint,
    component: React.ComponentType<ExtensionProps>,
    options?: ExtensionOptions
  ) => () => void

  /** Get all extensions for a point */
  getExtensions: (point: ExtensionPoint) => ExtensionRegistration[]

  /** Check if extensions exist for a point */
  hasExtensions: (point: ExtensionPoint) => boolean
}

// =============================================================================
// Permission API - Security
// =============================================================================

/**
 * Plugin API permissions for extended features
 */
export type PluginAPIPermission =
  | "session:read"
  | "session:write"
  | "session:delete"
  | "project:read"
  | "project:write"
  | "project:delete"
  | "vector:read"
  | "vector:write"
  | "canvas:read"
  | "canvas:write"
  | "artifact:read"
  | "artifact:write"
  | "ai:chat"
  | "ai:embed"
  | "export:session"
  | "export:project"
  | "theme:read"
  | "theme:write"
  | "media:image:read"
  | "media:image:write"
  | "media:video:read"
  | "media:video:write"
  | "media:video:export"
  | "extension:ui"
  | "notification:show"

/**
 * Permission API for plugins
 */
export interface PluginPermissionAPI {
  /** Check if plugin has a permission */
  hasPermission: (permission: PluginAPIPermission) => boolean

  /** Request a permission from user */
  requestPermission: (permission: PluginAPIPermission, reason?: string) => Promise<boolean>

  /** Get all granted permissions */
  getGrantedPermissions: () => PluginAPIPermission[]

  /** Check multiple permissions */
  hasAllPermissions: (permissions: PluginAPIPermission[]) => boolean

  /** Check if any permission is granted */
  hasAnyPermission: (permissions: PluginAPIPermission[]) => boolean
}

// =============================================================================
// Plugin Context API
// =============================================================================

/**
 * Plugin context API with all feature-specific APIs
 */
export interface PluginContextAPI {
  /** Session management API */
  session: PluginSessionAPI

  /** Project management API */
  project: PluginProjectAPI

  /** Vector/RAG API */
  vector: PluginVectorAPI

  /** Theme customization API */
  theme: PluginThemeAPI

  /** Export API */
  export: PluginExportAPI

  /** Internationalization API */
  i18n: PluginI18nAPI

  /** Canvas editing API */
  canvas: PluginCanvasAPI

  /** Artifact management API */
  artifact: PluginArtifactAPI

  /** Media processing API */
  media: PluginMediaAPI

  /** Notification center API */
  notifications: PluginNotificationCenterAPI

  /** Per-plugin persistent key-value storage */
  storage: PluginStorageAPI

  /** AI provider API */
  ai: PluginAIProviderAPI

  /** UI extension points API */
  extensions: PluginExtensionAPI

  /** Permission management API */
  permissions: PluginPermissionAPI
}

// =============================================================================
// Backward Compatibility Aliases (Deprecated)
// =============================================================================

/**
 * @deprecated Use `PluginContextAPI` instead
 */
export type ExtendedPluginContext = PluginContextAPI

/**
 * @deprecated Use `PluginAPIPermission` instead
 */
export type ExtendedPluginPermission = PluginAPIPermission
