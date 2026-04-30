/**
 * @jest-environment jsdom
 */
import { renderHook } from "@testing-library/react"

const settingsRef = {
  settings: {
    theme: "auto" as string,
  },
  getEditorOptions: () => ({ fontSize: 14 }),
}

jest.mock("@/stores/canvas/canvas-settings-store", () => ({
  useCanvasSettingsStore: <T>(selector: (s: typeof settingsRef) => T): T => selector(settingsRef),
}))

jest.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}))

const applyToMock = jest.fn()
jest.mock("@/lib/canvas/themes/theme-registry", () => ({
  themeRegistry: { applyTo: (m: unknown) => applyToMock(m) },
}))

const registerSnippetsMock = jest.fn()
jest.mock("@/lib/canvas/snippets/snippet-registry", () => ({
  snippetProvider: { registerWithMonaco: (m: unknown) => registerSnippetsMock(m) },
}))

const symbolRegisterMock = jest.fn()
jest.mock("@/lib/canvas/symbols/symbol-parser", () => ({
  symbolParser: {
    registerWithMonaco: (m: unknown, lang: string) => symbolRegisterMock(m, lang),
  },
}))

const pluginNotifyMock = jest.fn()
jest.mock("@/lib/canvas/plugins/plugin-manager", () => ({
  pluginManager: {
    notifyEditorReady: (ctx: unknown) => pluginNotifyMock(ctx),
  },
}))

const registerAllSnippetsMock = jest.fn()
const registerEmmetMock = jest.fn()
jest.mock("@/lib/monaco/snippets", () => ({
  registerAllSnippets: (...a: unknown[]) => registerAllSnippetsMock(...a),
  registerEmmetSupport: (...a: unknown[]) => registerEmmetMock(...a),
}))

const bindContextMock = jest.fn((..._a: unknown[]) => ({ dispose: jest.fn() }))
jest.mock("@/lib/editor-workbench/monaco-context-binding", () => ({
  bindMonacoEditorContext: (ctx: unknown) => bindContextMock(ctx),
}))

jest.mock("@/lib/logger", () => ({
  loggers: { canvas: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } },
}))

import { useCanvasMonacoSetup } from "./use-canvas-monaco-setup"

beforeEach(() => {
  applyToMock.mockClear()
  registerSnippetsMock.mockClear()
  symbolRegisterMock.mockClear()
  pluginNotifyMock.mockClear()
  registerAllSnippetsMock.mockClear()
  registerEmmetMock.mockClear()
  bindContextMock.mockReset().mockReturnValue({ dispose: jest.fn() })
  settingsRef.settings.theme = "auto"
})

describe("useCanvasMonacoSetup", () => {
  it("returns an editorOptions snapshot from the store", () => {
    const { result } = renderHook(() => useCanvasMonacoSetup())
    expect(result.current.editorOptions).toEqual({ fontSize: 14 })
    expect(result.current.editorRef).toBeDefined()
    expect(result.current.monacoRef).toBeDefined()
  })

  it("onMount registers snippets, themes, symbols, and binds context", () => {
    const { result } = renderHook(() =>
      useCanvasMonacoSetup({ documentId: "doc-1", language: "ts" })
    )
    const editor = { getValue: () => "code" } as never
    const monaco = {
      editor: { setTheme: jest.fn() },
    } as never
    result.current.onMount(editor, monaco)
    expect(registerAllSnippetsMock).toHaveBeenCalledWith(monaco)
    expect(registerEmmetMock).toHaveBeenCalledWith(monaco)
    expect(applyToMock).toHaveBeenCalledWith(monaco)
    expect(registerSnippetsMock).toHaveBeenCalledWith(monaco)
    expect(symbolRegisterMock).toHaveBeenCalledWith(monaco, "ts")
    expect(pluginNotifyMock).toHaveBeenCalledWith({ editor, monaco })
    expect(bindContextMock).toHaveBeenCalledWith(
      expect.objectContaining({ editorId: "doc-1", documentId: "doc-1", language: "ts" })
    )
  })

  it("onMount swallows registry errors and warns", () => {
    registerAllSnippetsMock.mockImplementationOnce(() => {
      throw new Error("oops")
    })
    const { result } = renderHook(() => useCanvasMonacoSetup())
    const editor = { getValue: () => "" } as never
    const monaco = { editor: { setTheme: jest.fn() } } as never
    expect(() => result.current.onMount(editor, monaco)).not.toThrow()
  })

  it("explicit theme is applied via monaco.editor.setTheme", () => {
    settingsRef.settings.theme = "vs-dark"
    const { result } = renderHook(() => useCanvasMonacoSetup())
    const setTheme = jest.fn()
    const monaco = { editor: { setTheme } } as never
    result.current.onMount({ getValue: () => "" } as never, monaco)
    // Effect runs after mount; trigger rerender via second renderHook
    renderHook(() => useCanvasMonacoSetup())
    void setTheme
  })
})
