type Handler = (
  payload: unknown,
  context: { pluginId: string; method: string; requestId: null }
) => unknown
const handlers = new Map<string, Handler>()

jest.mock("./rpc-dispatcher", () => ({
  registerMethod: (method: string, handler: Handler) => {
    handlers.set(method, handler)
    return () => handlers.delete(method)
  },
}))

const mockBridge = {
  applyEditorEdit: jest.fn(() => true),
  disposeDecorationType: jest.fn(() => true),
  insertEditorSnippet: jest.fn(() => false),
  registerDecorationType: jest.fn(),
  revealEditorRange: jest.fn(),
  setDecorations: jest.fn(() => true),
  setEditorOptions: jest.fn(),
  setEditorSelections: jest.fn(),
}
jest.mock("./monaco-bridge", () => ({
  get applyEditorEdit() {
    return mockBridge.applyEditorEdit
  },
  get disposeDecorationType() {
    return mockBridge.disposeDecorationType
  },
  get insertEditorSnippet() {
    return mockBridge.insertEditorSnippet
  },
  get registerDecorationType() {
    return mockBridge.registerDecorationType
  },
  get revealEditorRange() {
    return mockBridge.revealEditorRange
  },
  get setDecorations() {
    return mockBridge.setDecorations
  },
  get setEditorOptions() {
    return mockBridge.setEditorOptions
  },
  get setEditorSelections() {
    return mockBridge.setEditorSelections
  },
}))

import { installVscodeEditorHandlers } from "./editor-handlers"

const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
const call = (method: string, payload: unknown, pluginId = "ext.a") =>
  handlers.get(method)!(payload, { pluginId, method, requestId: null })

beforeEach(() => {
  handlers.clear()
  jest.clearAllMocks()
  installVscodeEditorHandlers()
})

it("decoration types belong to the extension that minted the key", () => {
  call("window:registerDecorationType", {
    extensionId: "ext.a",
    key: "deco:ext.a:1",
    options: { color: "red" },
  })
  expect(mockBridge.registerDecorationType).toHaveBeenCalledWith({
    extensionId: "ext.a",
    key: "deco:ext.a:1",
    options: { color: "red" },
  })
  expect(() =>
    call("window:setDecorations", { editorId: "e", key: "deco:ext.b:1", decorations: [] })
  ).toThrow(/does not belong/)
  expect(() =>
    call("window:registerDecorationType", { extensionId: "ext.b", key: "deco:ext.b:1" })
  ).toThrow(/ownership/)
  call("window:setDecorations", { editorId: "e", key: "deco:ext.a:1", decorations: [{ range }] })
  expect(mockBridge.setDecorations).toHaveBeenCalledWith({
    editorId: "e",
    typeId: "deco:ext.a:1",
    decorations: [{ range }],
  })
  call("window:disposeDecorationType", { extensionId: "ext.a", key: "deco:ext.a:1" })
  expect(mockBridge.disposeDecorationType).toHaveBeenCalledWith("deco:ext.a:1")
})

it("edits and snippets answer whether they applied", () => {
  expect(
    call("window:editorEdit", {
      editorId: "e",
      version: "4",
      edits: [{ range, text: "x" }],
      options: { undoStopBefore: false },
    })
  ).toBe(true)
  expect(mockBridge.applyEditorEdit).toHaveBeenCalledWith({
    editorId: "e",
    version: 4,
    edits: [{ range, text: "x" }],
    options: { undoStopBefore: false },
  })
  expect(
    call("window:editorInsertSnippet", {
      editorId: "e",
      version: 4,
      snippet: "$1",
      ranges: [range],
    })
  ).toBe(false)
})

it("reveal, selections and options go to the bridge", () => {
  call("window:revealRange", { editorId: "e", range, revealType: 3 })
  expect(mockBridge.revealEditorRange).toHaveBeenCalledWith({ editorId: "e", range, revealType: 3 })
  call("window:setSelections", {
    editorId: "e",
    selections: [{ anchor: range.start, active: range.end }],
  })
  expect(mockBridge.setEditorSelections).toHaveBeenCalledWith({
    editorId: "e",
    selections: [{ anchor: range.start, active: range.end }],
  })
  call("window:setEditorOptions", { editorId: "e", options: { tabSize: 8 } })
  expect(mockBridge.setEditorOptions).toHaveBeenCalledWith({
    editorId: "e",
    options: { tabSize: 8 },
  })
  expect(() => call("window:setEditorOptions", null)).toThrow(/object/)
})
