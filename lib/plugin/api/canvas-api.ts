/**
 * Plugin Canvas API Implementation
 *
 * Provides canvas document editing capabilities to plugins.
 */

import { getActiveEditorContext } from "@/lib/editor-workbench/editor-context-registry"
import { mapToArtifactLanguage } from "@/lib/artifacts/constants"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import {
  executeCanvasAction,
  executeCanvasActionStreaming,
  type CanvasActionConfig,
  type CanvasActionExecutionOptions,
  type CanvasActionResult,
  type CanvasActionType,
  type StreamingCallbacks,
} from "@/lib/ai/generation/canvas-actions"
import * as canvasCommentsDb from "@/lib/db/canvas-comments"
import * as canvasSessionsDb from "@/lib/db/canvas-sessions"
import { crdtStore } from "@/lib/canvas/collaboration/crdt-store"
import { runPython, type PythonExecResult } from "@/lib/tauri/canvas"
import type {
  PluginCanvasAPI,
  PluginCanvasDocument,
  CreateCanvasDocumentOptions,
  CanvasSelection,
} from "@/types/plugin/plugin"
import type {
  ArtifactLanguage,
  CanvasDocumentVersion,
  CanvasEditorSelection,
  CanvasSuggestion,
} from "@/types/artifact"
import type { CanvasComment, CollaborativeSession } from "@/types/canvas/collaboration"
import type { AddCommentInput, ReplyInput } from "@/lib/db/canvas-comments"
import { createPluginSystemLogger } from "../core/logger"
import { createApiGuardedAPI } from "./api-permission-gate"

type LineColumn = {
  lineNumber: number
  column: number
}

type CanvasEditorSelectionLike = CanvasEditorSelection & {
  getStartPosition?: () => LineColumn
  getEndPosition?: () => LineColumn
  isEmpty?: () => boolean
}

function isCanvasSuggestion(value: unknown): value is CanvasSuggestion {
  if (!value || typeof value !== "object") {
    return false
  }

  const suggestion = value as Partial<CanvasSuggestion>
  const range = suggestion.range as Partial<CanvasSuggestion["range"]> | undefined

  return (
    typeof suggestion.id === "string" &&
    (suggestion.type === "edit" ||
      suggestion.type === "comment" ||
      suggestion.type === "fix" ||
      suggestion.type === "improve") &&
    typeof range?.startLine === "number" &&
    typeof range?.endLine === "number" &&
    typeof suggestion.originalText === "string" &&
    typeof suggestion.suggestedText === "string" &&
    typeof suggestion.explanation === "string" &&
    (suggestion.status === "pending" ||
      suggestion.status === "accepted" ||
      suggestion.status === "rejected")
  )
}

function isArtifactLanguage(value: string): value is ArtifactLanguage {
  return [
    "javascript",
    "typescript",
    "python",
    "plaintext",
    "html",
    "css",
    "json",
    "markdown",
    "jsx",
    "tsx",
    "sql",
    "bash",
    "yaml",
    "xml",
    "svg",
    "mermaid",
    "latex",
  ].includes(value)
}

function normalizeDocumentLanguage(language?: string): ArtifactLanguage {
  const normalized = language?.trim().toLowerCase()
  if (!normalized) {
    return "markdown"
  }

  return (
    mapToArtifactLanguage(normalized) ?? (isArtifactLanguage(normalized) ? normalized : "markdown")
  )
}

function toPluginDocument(doc: {
  id: string
  sessionId: string
  title: string
  content: string
  language?: string
  type: "code" | "text"
  createdAt: Date | string
  updatedAt: Date | string
  aiSuggestions?: unknown[]
  versions?: CanvasDocumentVersion[]
}): PluginCanvasDocument {
  return {
    id: doc.id,
    sessionId: doc.sessionId,
    title: doc.title,
    content: doc.content,
    language: normalizeDocumentLanguage(doc.language),
    type: doc.type,
    createdAt: new Date(doc.createdAt),
    updatedAt: new Date(doc.updatedAt),
    suggestions: doc.aiSuggestions?.filter(isCanvasSuggestion),
    versions: doc.versions,
  }
}

function getActiveCanvasDocumentState() {
  const store = useArtifactStore.getState()
  const activeId = store.activeCanvasId
  const doc = activeId ? store.canvasDocuments[activeId] : null
  return {
    store,
    activeId,
    doc,
  }
}

function getActiveCanvasEditor() {
  const context = getActiveEditorContext()
  if (!context || context.contextId !== "canvas") {
    return null
  }
  return context.editor
}

function normalizeSelection(selection: CanvasEditorSelectionLike): CanvasEditorSelection {
  return {
    startLineNumber: selection.startLineNumber,
    startColumn: selection.startColumn,
    endLineNumber: selection.endLineNumber,
    endColumn: selection.endColumn,
  }
}

function isSelectionEmpty(selection: CanvasEditorSelectionLike | null | undefined): boolean {
  if (!selection) {
    return true
  }
  if (typeof selection.isEmpty === "function") {
    return selection.isEmpty()
  }
  return (
    selection.startLineNumber === selection.endLineNumber &&
    selection.startColumn === selection.endColumn
  )
}

function getSelectionStart(selection: CanvasEditorSelectionLike): LineColumn {
  return (
    selection.getStartPosition?.() || {
      lineNumber: selection.startLineNumber,
      column: selection.startColumn,
    }
  )
}

function getSelectionEnd(selection: CanvasEditorSelectionLike): LineColumn {
  return (
    selection.getEndPosition?.() || {
      lineNumber: selection.endLineNumber,
      column: selection.endColumn,
    }
  )
}

function lineColumnToOffset(content: string, position: LineColumn): number {
  const lines = content.split("\n")
  let offset = 0

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1
    if (lineNumber === position.lineNumber) {
      return offset + Math.max(0, position.column - 1)
    }
    offset += lines[index].length + 1
  }

  return content.length
}

function offsetToLineColumn(content: string, offset: number): LineColumn {
  const target = Math.max(0, Math.min(offset, content.length))
  const lines = content.split("\n")
  let running = 0

  for (let index = 0; index < lines.length; index += 1) {
    const lineLength = lines[index].length
    const lineEnd = running + lineLength
    if (target <= lineEnd) {
      return {
        lineNumber: index + 1,
        column: target - running + 1,
      }
    }
    running = lineEnd + 1
  }

  return {
    lineNumber: lines.length,
    column: lines[lines.length - 1].length + 1,
  }
}

function selectionToCanvasSelection(
  content: string,
  selection: CanvasEditorSelectionLike
): CanvasSelection | null {
  if (isSelectionEmpty(selection)) {
    return null
  }

  const start = lineColumnToOffset(content, getSelectionStart(selection))
  const end = lineColumnToOffset(content, getSelectionEnd(selection))

  return {
    start,
    end,
    text: content.slice(start, end),
  }
}

/**
 * Create the Canvas API for a plugin
 */
export function createCanvasAPI(pluginId: string): PluginCanvasAPI {
  const logger = createPluginSystemLogger(pluginId)
  const api: PluginCanvasAPI = {
    getCurrentDocument: (): PluginCanvasDocument | null => {
      const { doc } = getActiveCanvasDocumentState()
      if (!doc) return null

      return toPluginDocument(doc)
    },

    getDocument: (id: string): PluginCanvasDocument | null => {
      // Workspace-scoped: a plugin running in one workspace must not be able to
      // read a document that belongs to another. `null` covers both "missing"
      // and "not yours" so the two cannot be told apart.
      const doc = useArtifactStore.getState().getCanvasDocumentForWorkspace(id)
      if (!doc) return null

      return toPluginDocument(doc)
    },

    createDocument: async (options: CreateCanvasDocumentOptions): Promise<string> => {
      const store = useArtifactStore.getState()
      const id = store.createCanvasDocument({
        sessionId: options.sessionId,
        title: options.title,
        content: options.content,
        language: options.language,
        type: options.type,
      })
      logger.info(`Created canvas document: ${id}`)
      return id
    },

    updateDocument: (id: string, updates: Partial<PluginCanvasDocument>) => {
      const store = useArtifactStore.getState()
      store.updateCanvasDocument(id, {
        title: updates.title,
        content: updates.content,
        language: updates.language,
      })
      logger.info(`Updated canvas document: ${id}`)
    },

    deleteDocument: (id: string) => {
      const store = useArtifactStore.getState()
      store.deleteCanvasDocument(id)
      logger.info(`Deleted canvas document: ${id}`)
    },

    openDocument: (id: string) => {
      const store = useArtifactStore.getState()
      store.setActiveCanvas(id)
      store.setPanelView("canvas")
      logger.info(`Opened canvas document: ${id}`)
    },

    closeCanvas: () => {
      const store = useArtifactStore.getState()
      // `canvasOpen` was a second visibility flag nothing ever read; closing
      // the canvas means dropping the active document, which every canvas
      // surface already keys off.
      store.setActiveCanvas(null)
      logger.info("Closed canvas")
    },

    getSelection: (): CanvasSelection | null => {
      const { doc } = getActiveCanvasDocumentState()
      if (!doc) return null

      const editor = getActiveCanvasEditor()
      const editorSelection = editor?.getSelection?.() as
        CanvasEditorSelectionLike | null | undefined
      if (editorSelection) {
        return selectionToCanvasSelection(doc.content, editorSelection)
      }

      return doc.editorContext?.selection
        ? selectionToCanvasSelection(doc.content, doc.editorContext.selection)
        : null
    },

    setSelection: (start: number, end: number) => {
      const { store, activeId, doc } = getActiveCanvasDocumentState()
      if (!activeId || !doc) return

      const anchor = offsetToLineColumn(doc.content, start)
      const focus = offsetToLineColumn(doc.content, end)
      const selection: CanvasEditorSelection = {
        startLineNumber: anchor.lineNumber,
        startColumn: anchor.column,
        endLineNumber: focus.lineNumber,
        endColumn: focus.column,
      }

      const editor = getActiveCanvasEditor()
      editor?.setSelection?.(selection as never)
      editor?.focus?.()

      store.updateCanvasDocument(activeId, {
        editorContext: {
          selection,
        },
      })
      logger.debug(`setSelection requested: ${start}-${end}`)
    },

    insertText: (text: string) => {
      const { store, activeId, doc } = getActiveCanvasDocumentState()
      if (!activeId || !doc) return

      // Prefer the live editor: insert at the caret / replace the selection.
      const editor = getActiveCanvasEditor()
      if (editor) {
        const selection = editor.getSelection?.() as CanvasEditorSelectionLike | null | undefined
        const position = editor.getPosition?.() as LineColumn | null | undefined
        const range =
          selection ??
          (position
            ? {
                startLineNumber: position.lineNumber,
                startColumn: position.column,
                endLineNumber: position.lineNumber,
                endColumn: position.column,
              }
            : null)
        if (range) {
          editor.executeEdits?.("plugin-canvas-api", [{ range, text }])
          editor.focus?.()
          const model = editor.getModel?.()
          const nextContent = (model?.getValue?.() as string | undefined) ?? doc.content + text
          store.updateCanvasDocument(activeId, { content: nextContent })
          logger.info("Inserted text at the canvas caret")
          return
        }
      }

      // No live editor: insert at the store's tracked cursor, else append.
      const tracked = doc.editorContext?.selection
      const newContent = tracked
        ? (() => {
            const offset = lineColumnToOffset(doc.content, getSelectionStart(tracked))
            return `${doc.content.slice(0, offset)}${text}${doc.content.slice(offset)}`
          })()
        : doc.content + text
      store.updateCanvasDocument(activeId, { content: newContent })
      logger.info("Inserted text into canvas")
    },

    replaceSelection: (text: string) => {
      const { store, activeId, doc } = getActiveCanvasDocumentState()
      if (!activeId || !doc) return

      const editor = getActiveCanvasEditor()
      const editorSelection = editor?.getSelection?.() as
        CanvasEditorSelectionLike | null | undefined
      const selection =
        editorSelection && !isSelectionEmpty(editorSelection)
          ? normalizeSelection(editorSelection)
          : doc.editorContext?.selection || null

      if (!selection || isSelectionEmpty(selection)) {
        return
      }

      let nextContent = doc.content
      let nextSelection: CanvasEditorSelection | null = null

      if (editor) {
        editor.executeEdits?.("plugin-canvas-api", [
          {
            range: selection,
            text,
          },
        ])

        const model = editor.getModel?.()
        nextContent = model?.getValue?.() || nextContent
        const resultingSelection = editor.getSelection?.() as
          CanvasEditorSelectionLike | null | undefined
        nextSelection = resultingSelection ? normalizeSelection(resultingSelection) : null
      } else {
        const start = lineColumnToOffset(doc.content, getSelectionStart(selection))
        const end = lineColumnToOffset(doc.content, getSelectionEnd(selection))
        nextContent = `${doc.content.slice(0, start)}${text}${doc.content.slice(end)}`
        const cursor = offsetToLineColumn(nextContent, start + text.length)
        nextSelection = {
          startLineNumber: cursor.lineNumber,
          startColumn: cursor.column,
          endLineNumber: cursor.lineNumber,
          endColumn: cursor.column,
        }
      }

      store.updateCanvasDocument(activeId, {
        content: nextContent,
        editorContext: {
          selection: nextSelection,
        },
      })
      logger.info("Replaced selection in canvas")
    },

    getContent: (id?: string): string => {
      const store = useArtifactStore.getState()
      const docId = id || store.activeCanvasId
      if (!docId) return ""

      const doc = store.canvasDocuments[docId]
      return doc?.content || ""
    },

    setContent: (content: string, id?: string) => {
      const store = useArtifactStore.getState()
      const docId = id || store.activeCanvasId
      if (!docId) return

      store.updateCanvasDocument(docId, { content })
      logger.info("Set canvas content")
    },

    saveVersion: async (id: string, description?: string): Promise<string> => {
      const store = useArtifactStore.getState()
      const result = store.saveCanvasVersion(id, description, false)
      const versionId = typeof result === "string" ? result : result?.id || ""
      logger.info(`Saved canvas version: ${versionId}`)
      return versionId
    },

    restoreVersion: (documentId: string, versionId: string) => {
      const store = useArtifactStore.getState()
      store.restoreCanvasVersion(documentId, versionId)
      logger.info(`Restored canvas version: ${versionId}`)
    },

    getVersions: (id: string): CanvasDocumentVersion[] => {
      const store = useArtifactStore.getState()
      const doc = store.canvasDocuments[id]
      return doc?.versions || []
    },

    onCanvasChange: (handler: (doc: PluginCanvasDocument | null) => void) => {
      let lastCanvasId: string | null = null

      const unsubscribe = useArtifactStore.subscribe((state) => {
        if (state.activeCanvasId !== lastCanvasId) {
          lastCanvasId = state.activeCanvasId

          if (!state.activeCanvasId) {
            handler(null)
            return
          }

          const doc = state.canvasDocuments[state.activeCanvasId]
          if (doc) {
            handler(toPluginDocument(doc))
          } else {
            handler(null)
          }
        }
      })

      return unsubscribe
    },

    onContentChange: (handler: (content: string) => void) => {
      let lastContent: string | null = null

      const unsubscribe = useArtifactStore.subscribe((state) => {
        const activeId = state.activeCanvasId
        if (!activeId) return

        const doc = state.canvasDocuments[activeId]
        if (doc && doc.content !== lastContent) {
          lastContent = doc.content
          handler(doc.content)
        }
      })

      return unsubscribe
    },

    // Python sandbox -- forwards to lib/tauri/canvas.runPython, which throws
    // on web mode. Plugin host should require the canvas:run permission.
    executePython: async (code: string, timeoutMs?: number): Promise<PythonExecResult> => {
      logger.info("executePython invoked")
      return runPython(code, timeoutMs)
    },

    // AI actions -- thin forwarders to lib/ai/generation/canvas-actions so
    // plugins reuse the existing prompt library / streaming machinery.
    executeAction: async (
      actionType: CanvasActionType,
      content: string,
      config: CanvasActionConfig,
      options?: CanvasActionExecutionOptions
    ): Promise<CanvasActionResult> => {
      logger.info(`executeAction: ${actionType}`)
      return executeCanvasAction(actionType, content, config, options)
    },

    executeActionStreaming: async (
      actionType: CanvasActionType,
      content: string,
      config: CanvasActionConfig,
      callbacks: StreamingCallbacks,
      options?: CanvasActionExecutionOptions
    ): Promise<void> => {
      logger.info(`executeActionStreaming: ${actionType}`)
      return executeCanvasActionStreaming(actionType, content, config, callbacks, options)
    },

    // Comments -- forwarders to lib/db/canvas-comments. The reactive store
    // (useCommentStore) listens to its own writes; plugins go straight to
    // Dexie because they live outside the React tree.
    getComments: (docId: string): Promise<CanvasComment[]> => {
      return canvasCommentsDb.listForDocument(docId)
    },

    addComment: async (input: AddCommentInput): Promise<CanvasComment> => {
      logger.info(`addComment doc=${input.documentId}`)
      return canvasCommentsDb.addComment(input)
    },

    updateComment: async (commentId: string, content: string): Promise<void> => {
      logger.info(`updateComment ${commentId}`)
      return canvasCommentsDb.updateComment(commentId, content)
    },

    resolveComment: async (commentId: string, resolvedBy?: string): Promise<void> => {
      logger.info(`resolveComment ${commentId}`)
      return canvasCommentsDb.resolveComment(commentId, resolvedBy)
    },

    replyToComment: async (parentId: string, reply: ReplyInput): Promise<CanvasComment> => {
      logger.info(`replyToComment parent=${parentId}`)
      return canvasCommentsDb.replyToComment(parentId, reply)
    },

    deleteComment: async (commentId: string): Promise<void> => {
      logger.info(`deleteComment ${commentId}`)
      return canvasCommentsDb.deleteComment(commentId)
    },

    // Collaboration sessions -- routed through the shared CRDT singleton +
    // its Dexie persistence hooks (commit 3). createCollaborationSession
    // returns synchronously because the CRDT path is in-memory; persistence
    // is fire-and-forget by design.
    createCollaborationSession: (documentId: string, content: string): CollaborativeSession => {
      logger.info(`createCollaborationSession doc=${documentId}`)
      return crdtStore.createSession(documentId, content)
    },

    getCollaborationSession: async (
      sessionId: string
    ): Promise<CollaborativeSession | undefined> => {
      const live = crdtStore.getSession(sessionId)
      if (live) return live
      return canvasSessionsDb.getSession(sessionId)
    },

    getActiveCollaborationSession: (
      documentId: string
    ): Promise<CollaborativeSession | undefined> => {
      return canvasSessionsDb.getActiveSessionForDocument(documentId)
    },

    listRecentCollaborationSessions: (limit?: number): Promise<CollaborativeSession[]> => {
      return canvasSessionsDb.listRecent(limit)
    },

    closeCollaborationSession: (sessionId: string): void => {
      logger.info(`closeCollaborationSession ${sessionId}`)
      crdtStore.closeSession(sessionId)
    },
  }

  // Reads → canvas:read, mutations → canvas:write, code/action execution →
  // canvas:run, collaboration session lifecycle → canvas:collaborate.
  return createApiGuardedAPI(pluginId, api, {
    getCurrentDocument: "canvas:read",
    getDocument: "canvas:read",
    createDocument: "canvas:write",
    updateDocument: "canvas:write",
    deleteDocument: "canvas:write",
    openDocument: "canvas:write",
    closeCanvas: "canvas:write",
    getSelection: "canvas:read",
    setSelection: "canvas:write",
    insertText: "canvas:write",
    replaceSelection: "canvas:write",
    getContent: "canvas:read",
    setContent: "canvas:write",
    saveVersion: "canvas:write",
    restoreVersion: "canvas:write",
    getVersions: "canvas:read",
    onCanvasChange: "canvas:read",
    onContentChange: "canvas:read",
    executePython: "canvas:run",
    executeAction: "canvas:run",
    executeActionStreaming: "canvas:run",
    getComments: "canvas:read",
    addComment: "canvas:write",
    updateComment: "canvas:write",
    resolveComment: "canvas:write",
    replyToComment: "canvas:write",
    deleteComment: "canvas:write",
    createCollaborationSession: "canvas:collaborate",
    getCollaborationSession: "canvas:read",
    getActiveCollaborationSession: "canvas:read",
    listRecentCollaborationSessions: "canvas:read",
    closeCollaborationSession: "canvas:collaborate",
  })
}
