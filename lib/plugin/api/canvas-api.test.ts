/**
 * Tests for Canvas Plugin API
 */

import "fake-indexeddb/auto"
import { createCanvasAPI } from "./canvas-api"

type MockCanvasEditorSelection = {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
  getStartPosition: () => { lineNumber: number; column: number }
  getEndPosition: () => { lineNumber: number; column: number }
  isEmpty: () => boolean
}

let mockActiveEditorContext: { contextId: string; editor: MockMonacoEditor } | null = null

// Mock artifact store for canvas operations
const mockCanvasDocuments: Record<
  string,
  {
    id: string
    sessionId: string
    title: string
    content: string
    language?: string
    type: string
    createdAt: string
    updatedAt: string
    aiSuggestions: unknown[]
    versions: unknown[]
    editorContext?: {
      selection?: {
        startLineNumber: number
        startColumn: number
        endLineNumber: number
        endColumn: number
      } | null
    }
  }
> = {}
let mockActiveCanvasId: string | null = null
let mockPanelView: string | null = null
const mockSubscribers: Array<(state: unknown) => void> = []

function clampOffset(value: number, content: string): number {
  return Math.max(0, Math.min(value, content.length))
}

function positionToOffset(
  content: string,
  position: { lineNumber: number; column: number }
): number {
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

function offsetToPosition(content: string, offset: number): { lineNumber: number; column: number } {
  const target = clampOffset(offset, content)
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

function createSelection(
  startLineNumber: number,
  startColumn: number,
  endLineNumber: number,
  endColumn: number
): MockCanvasEditorSelection {
  return {
    startLineNumber,
    startColumn,
    endLineNumber,
    endColumn,
    getStartPosition: () => ({ lineNumber: startLineNumber, column: startColumn }),
    getEndPosition: () => ({ lineNumber: endLineNumber, column: endColumn }),
    isEmpty: () => startLineNumber === endLineNumber && startColumn === endColumn,
  }
}

class MockMonacoEditor {
  private content: string
  private selection: MockCanvasEditorSelection | null
  focus = jest.fn()

  constructor(content: string, selection?: MockCanvasEditorSelection | null) {
    this.content = content
    this.selection = selection || null
  }

  getModel() {
    return {
      getValue: () => this.content,
      getValueInRange: (range: MockCanvasEditorSelection) => {
        const start = positionToOffset(this.content, range.getStartPosition())
        const end = positionToOffset(this.content, range.getEndPosition())
        return this.content.slice(start, end)
      },
      getOffsetAt: (position: { lineNumber: number; column: number }) =>
        positionToOffset(this.content, position),
      getPositionAt: (offset: number) => offsetToPosition(this.content, offset),
    }
  }

  getSelection() {
    return this.selection
  }

  setSelection(selection: MockCanvasEditorSelection) {
    this.selection = createSelection(
      selection.startLineNumber,
      selection.startColumn,
      selection.endLineNumber,
      selection.endColumn
    )
  }

  executeEdits(_source: string, edits: Array<{ range: MockCanvasEditorSelection; text: string }>) {
    for (const edit of edits) {
      const startPosition =
        typeof edit.range.getStartPosition === "function"
          ? edit.range.getStartPosition()
          : {
              lineNumber: edit.range.startLineNumber,
              column: edit.range.startColumn,
            }
      const endPosition =
        typeof edit.range.getEndPosition === "function"
          ? edit.range.getEndPosition()
          : {
              lineNumber: edit.range.endLineNumber,
              column: edit.range.endColumn,
            }
      const start = positionToOffset(this.content, startPosition)
      const end = positionToOffset(this.content, endPosition)
      this.content = `${this.content.slice(0, start)}${edit.text}${this.content.slice(end)}`
      const endOffset = start + edit.text.length
      const cursor = offsetToPosition(this.content, endOffset)
      this.selection = createSelection(
        cursor.lineNumber,
        cursor.column,
        cursor.lineNumber,
        cursor.column
      )
    }
  }
}

jest.mock("@/stores/artifact/artifact-store", () => ({
  useArtifactStore: {
    getState: jest.fn(() => ({
      canvasDocuments: mockCanvasDocuments,
      activeCanvasId: mockActiveCanvasId,
      createCanvasDocument: jest.fn((options) => {
        const id = `canvas-${Date.now()}`
        mockCanvasDocuments[id] = {
          id,
          ...options,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          aiSuggestions: [],
          versions: [],
        }
        return id
      }),
      updateCanvasDocument: jest.fn((id, updates) => {
        if (mockCanvasDocuments[id]) {
          Object.assign(mockCanvasDocuments[id], updates, {
            updatedAt: new Date().toISOString(),
          })
        }
      }),
      deleteCanvasDocument: jest.fn((id) => {
        delete mockCanvasDocuments[id]
      }),
      setActiveCanvas: jest.fn((id) => {
        mockActiveCanvasId = id
      }),
      setPanelView: jest.fn((view) => {
        mockPanelView = view
      }),
      closeCanvas: jest.fn(() => {
        mockActiveCanvasId = null
        mockPanelView = null
      }),
      saveCanvasVersion: jest.fn((id, description) => {
        const versionId = `version-${Date.now()}`
        if (mockCanvasDocuments[id]) {
          mockCanvasDocuments[id].versions.push({
            id: versionId,
            description,
            createdAt: new Date().toISOString(),
          })
        }
        return { id: versionId }
      }),
      restoreCanvasVersion: jest.fn(),
    })),
    subscribe: jest.fn((callback) => {
      mockSubscribers.push(callback)
      return () => {
        const idx = mockSubscribers.indexOf(callback)
        if (idx >= 0) mockSubscribers.splice(idx, 1)
      }
    }),
  },
}))

jest.mock("@/lib/editor-workbench/editor-context-registry", () => ({
  getActiveEditorContext: jest.fn(() => mockActiveEditorContext),
}))

describe("Canvas API", () => {
  const testPluginId = "test-plugin"

  beforeEach(() => {
    // Clear state
    Object.keys(mockCanvasDocuments).forEach((key) => delete mockCanvasDocuments[key])
    mockActiveCanvasId = null
    mockPanelView = null
    mockActiveEditorContext = null
    mockSubscribers.length = 0
  })

  describe("createCanvasAPI", () => {
    it("should create an API object with all expected methods", () => {
      const api = createCanvasAPI(testPluginId)

      expect(api).toBeDefined()
      expect(typeof api.getCurrentDocument).toBe("function")
      expect(typeof api.getDocument).toBe("function")
      expect(typeof api.createDocument).toBe("function")
      expect(typeof api.updateDocument).toBe("function")
      expect(typeof api.deleteDocument).toBe("function")
      expect(typeof api.openDocument).toBe("function")
      expect(typeof api.closeCanvas).toBe("function")
      expect(typeof api.getSelection).toBe("function")
      expect(typeof api.setSelection).toBe("function")
      expect(typeof api.insertText).toBe("function")
      expect(typeof api.replaceSelection).toBe("function")
      expect(typeof api.getContent).toBe("function")
      expect(typeof api.setContent).toBe("function")
      expect(typeof api.saveVersion).toBe("function")
      expect(typeof api.restoreVersion).toBe("function")
      expect(typeof api.getVersions).toBe("function")
      expect(typeof api.onCanvasChange).toBe("function")
      expect(typeof api.onContentChange).toBe("function")
    })
  })

  describe("getCurrentDocument", () => {
    it("should return null when no document is active", () => {
      const api = createCanvasAPI(testPluginId)

      const result = api.getCurrentDocument()
      expect(result).toBeNull()
    })

    it("should return current document when one is active", () => {
      const docId = "canvas-doc-1"
      mockCanvasDocuments[docId] = {
        id: docId,
        sessionId: "session-1",
        title: "Test Canvas",
        content: "Hello world",
        type: "text",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        aiSuggestions: [],
        versions: [],
      }
      mockActiveCanvasId = docId

      const api = createCanvasAPI(testPluginId)
      const result = api.getCurrentDocument()

      expect(result).toBeDefined()
      expect(result?.id).toBe(docId)
      expect(result?.title).toBe("Test Canvas")
    })
  })

  describe("getDocument", () => {
    it("should return document by ID", () => {
      const docId = "doc-123"
      mockCanvasDocuments[docId] = {
        id: docId,
        sessionId: "session-1",
        title: "Specific Doc",
        content: "content",
        type: "code",
        language: "typescript",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        aiSuggestions: [],
        versions: [],
      }

      const api = createCanvasAPI(testPluginId)
      const result = api.getDocument(docId)

      expect(result).toBeDefined()
      expect(result?.title).toBe("Specific Doc")
      expect(result?.language).toBe("typescript")
    })

    it("normalizes document language aliases and filters invalid suggestions", () => {
      const docId = "doc-normalized"
      mockCanvasDocuments[docId] = {
        id: docId,
        sessionId: "session-1",
        title: "Normalized Doc",
        content: "content",
        type: "code",
        language: "md",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        aiSuggestions: [
          {
            id: "suggestion-1",
            type: "edit",
            range: {
              startLine: 1,
              endLine: 1,
            },
            originalText: "old",
            suggestedText: "new",
            explanation: "Improve wording",
            status: "pending",
          },
          {
            id: "broken",
            type: "edit",
          },
        ],
        versions: [],
      }

      const api = createCanvasAPI(testPluginId)
      const result = api.getDocument(docId)

      expect(result?.language).toBe("markdown")
      expect(result?.suggestions).toEqual([
        expect.objectContaining({
          id: "suggestion-1",
          suggestedText: "new",
        }),
      ])
    })

    it("should return null for non-existent document", () => {
      const api = createCanvasAPI(testPluginId)
      const result = api.getDocument("non-existent")

      expect(result).toBeNull()
    })
  })

  describe("createDocument", () => {
    it("should create a new canvas document", async () => {
      const api = createCanvasAPI(testPluginId)

      const id = await api.createDocument({
        sessionId: "session-1",
        title: "New Canvas",
        content: "Initial content",
        type: "text",
        language: "markdown",
      })

      expect(id).toBeDefined()
      expect(typeof id).toBe("string")
    })
  })

  describe("updateDocument", () => {
    it("should update an existing document", () => {
      const docId = "update-doc"
      mockCanvasDocuments[docId] = {
        id: docId,
        sessionId: "session-1",
        title: "Original",
        content: "original content",
        type: "text",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        aiSuggestions: [],
        versions: [],
      }

      const api = createCanvasAPI(testPluginId)
      api.updateDocument(docId, {
        title: "Updated Title",
        content: "updated content",
      })

      expect(mockCanvasDocuments[docId].title).toBe("Updated Title")
      expect(mockCanvasDocuments[docId].content).toBe("updated content")
    })
  })

  describe("deleteDocument", () => {
    it("should delete a document", () => {
      const docId = "delete-doc"
      mockCanvasDocuments[docId] = {
        id: docId,
        sessionId: "session-1",
        title: "To Delete",
        content: "",
        type: "text",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        aiSuggestions: [],
        versions: [],
      }

      const api = createCanvasAPI(testPluginId)
      api.deleteDocument(docId)

      expect(mockCanvasDocuments[docId]).toBeUndefined()
    })
  })

  describe("openDocument / closeCanvas", () => {
    it("should open a document", () => {
      const api = createCanvasAPI(testPluginId)
      api.openDocument("doc-to-open")

      expect(mockActiveCanvasId).toBe("doc-to-open")
    })

    it("should close canvas", () => {
      mockActiveCanvasId = "active-doc"
      mockPanelView = "canvas"

      const api = createCanvasAPI(testPluginId)
      api.closeCanvas()

      expect(mockActiveCanvasId).toBeNull()
      expect(mockPanelView).toBeNull()
    })
  })

  describe("getContent / setContent", () => {
    it("should get content of active document", () => {
      const docId = "content-doc"
      mockCanvasDocuments[docId] = {
        id: docId,
        sessionId: "session-1",
        title: "Content Test",
        content: "This is the content",
        type: "text",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        aiSuggestions: [],
        versions: [],
      }
      mockActiveCanvasId = docId

      const api = createCanvasAPI(testPluginId)
      const content = api.getContent()

      expect(content).toBe("This is the content")
    })

    it("should get content by document ID", () => {
      const docId = "specific-doc"
      mockCanvasDocuments[docId] = {
        id: docId,
        sessionId: "session-1",
        title: "Specific",
        content: "Specific content",
        type: "text",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        aiSuggestions: [],
        versions: [],
      }

      const api = createCanvasAPI(testPluginId)
      const content = api.getContent(docId)

      expect(content).toBe("Specific content")
    })

    it("should return empty string for non-existent document", () => {
      const api = createCanvasAPI(testPluginId)
      const content = api.getContent("non-existent")

      expect(content).toBe("")
    })

    it("should set content of active document", () => {
      const docId = "set-content-doc"
      mockCanvasDocuments[docId] = {
        id: docId,
        sessionId: "session-1",
        title: "Set Content",
        content: "old content",
        type: "text",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        aiSuggestions: [],
        versions: [],
      }
      mockActiveCanvasId = docId

      const api = createCanvasAPI(testPluginId)
      api.setContent("new content")

      expect(mockCanvasDocuments[docId].content).toBe("new content")
    })
  })

  describe("insertText", () => {
    it("should insert text at end of document", () => {
      const docId = "insert-doc"
      mockCanvasDocuments[docId] = {
        id: docId,
        sessionId: "session-1",
        title: "Insert Test",
        content: "Hello",
        type: "text",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        aiSuggestions: [],
        versions: [],
      }
      mockActiveCanvasId = docId

      const api = createCanvasAPI(testPluginId)
      api.insertText(" World")

      expect(mockCanvasDocuments[docId].content).toBe("Hello World")
    })

    it("should do nothing when no active document", () => {
      const api = createCanvasAPI(testPluginId)

      // Should not throw
      expect(() => api.insertText("test")).not.toThrow()
    })
  })

  describe("Version management", () => {
    const docId = "version-doc"

    beforeEach(() => {
      mockCanvasDocuments[docId] = {
        id: docId,
        sessionId: "session-1",
        title: "Version Test",
        content: "content",
        type: "text",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        aiSuggestions: [],
        versions: [],
      }
    })

    it("should save a version", async () => {
      const api = createCanvasAPI(testPluginId)

      const versionId = await api.saveVersion(docId, "First version")

      expect(versionId).toBeDefined()
      expect(mockCanvasDocuments[docId].versions.length).toBe(1)
    })

    it("should get versions", () => {
      mockCanvasDocuments[docId].versions = [
        { id: "v1", description: "Version 1", createdAt: new Date().toISOString() },
        { id: "v2", description: "Version 2", createdAt: new Date().toISOString() },
      ]

      const api = createCanvasAPI(testPluginId)
      const versions = api.getVersions(docId)

      expect(versions.length).toBe(2)
    })

    it("should return empty array for non-existent document", () => {
      const api = createCanvasAPI(testPluginId)
      const versions = api.getVersions("non-existent")

      expect(versions).toEqual([])
    })
  })

  describe("onCanvasChange / onContentChange", () => {
    it("should subscribe to canvas changes", () => {
      const api = createCanvasAPI(testPluginId)
      const handler = jest.fn()

      const unsubscribe = api.onCanvasChange(handler)

      expect(typeof unsubscribe).toBe("function")
      expect(mockSubscribers.length).toBe(1)
    })

    it("should subscribe to content changes", () => {
      const api = createCanvasAPI(testPluginId)
      const handler = jest.fn()

      const unsubscribe = api.onContentChange(handler)

      expect(typeof unsubscribe).toBe("function")
      expect(mockSubscribers.length).toBe(1)
    })

    it("should unsubscribe when cleanup is called", () => {
      const api = createCanvasAPI(testPluginId)

      const unsub1 = api.onCanvasChange(jest.fn())
      const unsub2 = api.onContentChange(jest.fn())

      expect(mockSubscribers.length).toBe(2)

      unsub1()
      unsub2()

      expect(mockSubscribers.length).toBe(0)
    })
  })

  describe("getSelection", () => {
    it("returns the active Monaco selection as text and offsets", () => {
      const docId = "selection-doc"
      const content = "alpha\nbeta\ngamma"
      mockCanvasDocuments[docId] = {
        id: docId,
        sessionId: "session-1",
        title: "Selection Test",
        content,
        type: "text",
        language: "markdown",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        aiSuggestions: [],
        versions: [],
      }
      mockActiveCanvasId = docId
      mockActiveEditorContext = {
        contextId: "canvas",
        editor: new MockMonacoEditor(content, createSelection(2, 1, 2, 5)),
      }

      const api = createCanvasAPI(testPluginId)
      const selection = api.getSelection()

      expect(selection).toEqual({
        start: 6,
        end: 10,
        text: "beta",
      })
    })

    it("returns null when there is no active canvas selection", () => {
      const api = createCanvasAPI(testPluginId)
      const selection = api.getSelection()

      expect(selection).toBeNull()
    })
  })

  describe("setSelection", () => {
    it("sets the active Monaco selection from absolute offsets", () => {
      const docId = "set-selection-doc"
      const content = "alpha\nbeta\ngamma"
      mockCanvasDocuments[docId] = {
        id: docId,
        sessionId: "session-1",
        title: "Set Selection Test",
        content,
        type: "text",
        language: "markdown",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        aiSuggestions: [],
        versions: [],
        editorContext: {},
      }
      mockActiveCanvasId = docId
      const editor = new MockMonacoEditor(content)
      mockActiveEditorContext = {
        contextId: "canvas",
        editor,
      }

      const api = createCanvasAPI(testPluginId)
      api.setSelection(6, 10)

      expect(editor.getSelection()).toMatchObject({
        startLineNumber: 2,
        startColumn: 1,
        endLineNumber: 2,
        endColumn: 5,
      })
    })
  })

  describe("replaceSelection", () => {
    it("replaces the active selection instead of appending", () => {
      const docId = "replace-doc"
      const content = "hello world"
      mockCanvasDocuments[docId] = {
        id: docId,
        sessionId: "session-1",
        title: "Replace Test",
        content,
        type: "text",
        language: "markdown",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        aiSuggestions: [],
        versions: [],
        editorContext: {},
      }
      mockActiveCanvasId = docId
      mockActiveEditorContext = {
        contextId: "canvas",
        editor: new MockMonacoEditor(content, createSelection(1, 7, 1, 12)),
      }

      const api = createCanvasAPI(testPluginId)
      api.replaceSelection("plugin")

      expect(mockCanvasDocuments[docId].content).toBe("hello plugin")
    })
  })
})

// ---------------------------------------------------------------------------
// New surface added in commit 4: executePython, executeAction(Streaming),
// comments CRUD, collaboration sessions. These talk to real Dexie via
// fake-indexeddb (imported at file top) plus mocked Tauri / AI library calls.
// ---------------------------------------------------------------------------

jest.mock("@/lib/tauri/canvas", () => ({
  runPython: jest.fn(),
}))

jest.mock("@/lib/ai/generation/canvas-actions", () => {
  const actual = jest.requireActual("@/lib/ai/generation/canvas-actions")
  return {
    ...actual,
    executeCanvasAction: jest.fn(),
    executeCanvasActionStreaming: jest.fn(),
  }
})

import { runPython } from "@/lib/tauri/canvas"
import {
  executeCanvasAction,
  executeCanvasActionStreaming,
} from "@/lib/ai/generation/canvas-actions"
import * as canvasCommentsDb from "@/lib/db/canvas-comments"
import * as canvasSessionsDb from "@/lib/db/canvas-sessions"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

const mockedRunPython = runPython as jest.MockedFunction<typeof runPython>
const mockedExecuteCanvasAction = executeCanvasAction as jest.MockedFunction<
  typeof executeCanvasAction
>
const mockedExecuteCanvasActionStreaming = executeCanvasActionStreaming as jest.MockedFunction<
  typeof executeCanvasActionStreaming
>

const RANGE = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 }

describe("PluginCanvasAPI — new surface (commit 4)", () => {
  beforeEach(async () => {
    jest.clearAllMocks()
    await getDb().delete()
    __resetDbForTesting()
    getDb()
    await whenSeeded()
  })

  describe("executePython", () => {
    it("forwards to runPython and returns the sandbox result", async () => {
      mockedRunPython.mockResolvedValue({
        stdout: "hello\n",
        stderr: "",
        exit_code: 0,
        duration_ms: 12,
      })
      const api = createCanvasAPI("plugin-x")
      const r = await api.executePython("print('hello')", 5000)
      expect(mockedRunPython).toHaveBeenCalledWith("print('hello')", 5000)
      expect(r.stdout).toBe("hello\n")
    })

    it("propagates web-mode errors thrown by runPython", async () => {
      mockedRunPython.mockRejectedValue(new Error("tauri-only"))
      const api = createCanvasAPI("plugin-x")
      await expect(api.executePython("x")).rejects.toThrow("tauri-only")
    })
  })

  describe("executeAction / executeActionStreaming", () => {
    it("executeAction forwards to executeCanvasAction with config + options", async () => {
      mockedExecuteCanvasAction.mockResolvedValue({ success: true, result: "fixed" })
      const api = createCanvasAPI("plugin-x")
      const cfg = { provider: "openai" as const, model: "gpt-4", apiKey: "k" }
      const r = await api.executeAction("fix", "code", cfg, { language: "ts" })
      expect(mockedExecuteCanvasAction).toHaveBeenCalledWith("fix", "code", cfg, {
        language: "ts",
      })
      expect(r.result).toBe("fixed")
    })

    it("executeActionStreaming forwards callbacks", async () => {
      mockedExecuteCanvasActionStreaming.mockResolvedValue(undefined)
      const callbacks = {
        onToken: jest.fn(),
        onComplete: jest.fn(),
        onError: jest.fn(),
      }
      const api = createCanvasAPI("plugin-x")
      const cfg = { provider: "openai" as const, model: "gpt-4", apiKey: "k" }
      await api.executeActionStreaming("review", "code", cfg, callbacks)
      expect(mockedExecuteCanvasActionStreaming).toHaveBeenCalledWith(
        "review",
        "code",
        cfg,
        callbacks,
        undefined
      )
    })
  })

  describe("comments CRUD", () => {
    it("addComment / getComments round-trip via Dexie", async () => {
      const api = createCanvasAPI("plugin-x")
      const created = await api.addComment({
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        content: "first",
        range: RANGE,
      })
      expect(created.id).toBeDefined()
      const list = await api.getComments("doc1")
      expect(list.find((c) => c.id === created.id)?.content).toBe("first")
    })

    it("updateComment / resolveComment / deleteComment behave", async () => {
      const api = createCanvasAPI("plugin-x")
      const c = await api.addComment({
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        content: "x",
        range: RANGE,
      })
      await api.updateComment(c.id, "edited")
      await api.resolveComment(c.id, "owner")
      let list = await api.getComments("doc1")
      expect(list[0].content).toBe("edited")
      expect(list[0].resolvedAt).toBeInstanceOf(Date)
      await api.deleteComment(c.id)
      list = await api.getComments("doc1")
      expect(list).toEqual([])
    })

    it("replyToComment inherits parent range and parentId", async () => {
      const api = createCanvasAPI("plugin-x")
      const parent = await api.addComment({
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        content: "parent",
        range: RANGE,
      })
      const reply = await api.replyToComment(parent.id, {
        authorId: "u2",
        authorName: "U2",
        content: "reply",
      })
      expect(reply.parentId).toBe(parent.id)
      expect(reply.range).toEqual(RANGE)
    })
  })

  describe("collaboration sessions", () => {
    it("createCollaborationSession persists metadata and exposes via lookup", async () => {
      const api = createCanvasAPI("plugin-x")
      const session = api.createCollaborationSession("doc1", "hello")
      // Persistence is fire-and-forget; flush microtasks.
      await new Promise((r) => setTimeout(r, 5))
      expect(session.documentId).toBe("doc1")
      const fromMem = await api.getCollaborationSession(session.id)
      expect(fromMem?.id).toBe(session.id)
      const persisted = await canvasSessionsDb.getSession(session.id)
      expect(persisted?.id).toBe(session.id)
    })

    it("getActiveCollaborationSession reads from Dexie", async () => {
      const api = createCanvasAPI("plugin-x")
      api.createCollaborationSession("doc1", "x")
      await new Promise((r) => setTimeout(r, 5))
      const active = await api.getActiveCollaborationSession("doc1")
      expect(active?.documentId).toBe("doc1")
    })

    it("listRecentCollaborationSessions returns persisted rows", async () => {
      const api = createCanvasAPI("plugin-x")
      api.createCollaborationSession("d1", "x")
      api.createCollaborationSession("d2", "y")
      await new Promise((r) => setTimeout(r, 10))
      const rows = await api.listRecentCollaborationSessions(5)
      expect(rows.length).toBeGreaterThanOrEqual(2)
    })

    it("closeCollaborationSession soft-closes the row", async () => {
      const api = createCanvasAPI("plugin-x")
      const session = api.createCollaborationSession("doc1", "x")
      await new Promise((r) => setTimeout(r, 5))
      api.closeCollaborationSession(session.id)
      await new Promise((r) => setTimeout(r, 5))
      const persisted = await canvasSessionsDb.getSession(session.id)
      expect(persisted?.isActive).toBe(false)
    })

    it("getCollaborationSession falls back to Dexie when not in memory", async () => {
      // Seed Dexie directly without going through the in-memory CRDT store.
      await canvasSessionsDb.upsertSession({
        id: "sess-disk",
        documentId: "doc-disk",
        ownerId: "u",
        participants: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        isActive: true,
        permissions: { canEdit: true, canComment: true, canShare: true, canExport: true },
      })
      const api = createCanvasAPI("plugin-x")
      const found = await api.getCollaborationSession("sess-disk")
      expect(found?.documentId).toBe("doc-disk")
    })
  })
})

// Suppress unused warning when canvasCommentsDb import becomes unused in
// future refactors. It's kept here for parity with the canvas-api module.
void canvasCommentsDb
