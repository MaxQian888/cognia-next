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

// Cut the heavy `@/stores` barrel (→ artifact/plugin/chat → broker) out of this
// unit; the hook only needs `useSettingsStore` for the appearance palette.
jest.mock("@/stores", () => ({
  useSettingsStore: <T>(
    selector: (s: {
      colorTheme: string
      activeCustomThemeId: string | null
      customThemes: unknown[]
    }) => T
  ): T => selector({ colorTheme: "default", activeCustomThemeId: null, customThemes: [] }),
}))

jest.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}))

let mockBindings: Record<string, string> = { "canvas.find": "Ctrl+F" }
jest.mock("@/stores/canvas/keybinding-store", () => {
  const store = <T>(selector: (s: { bindings: Record<string, string> }) => T): T =>
    selector({ bindings: mockBindings })
  store.getState = () => ({ bindings: mockBindings })
  return { useKeybindingStore: store }
})

const disposeMock = jest.fn()
const registerCanvasEditorActionsMock = jest.fn((..._a: unknown[]) => [{ dispose: disposeMock }])
jest.mock("@/lib/canvas/register-canvas-editor-actions", () => ({
  registerCanvasEditorActions: (...a: unknown[]) => registerCanvasEditorActionsMock(...a),
}))

const registerAllSnippetsMock = jest.fn()
const registerEmmetMock = jest.fn()
jest.mock("@/lib/monaco/snippets", () => ({
  registerAllSnippets: (...a: unknown[]) => registerAllSnippetsMock(...a),
  registerEmmetSupport: (...a: unknown[]) => registerEmmetMock(...a),
}))

const mountWorkbenchMock = jest.fn((..._a: unknown[]) => ({
  uri: "canvas:///default/doc-1.ts",
  dispose: jest.fn(),
}))
jest.mock("@/lib/editor-workbench/monaco-workbench", () => ({
  mountMonacoWorkbench: (editor: unknown, monaco: unknown, spec: unknown) =>
    mountWorkbenchMock(editor, monaco, spec),
}))

jest.mock("@/lib/logging", () => ({
  loggers: { canvas: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } },
}))

import { useCanvasMonacoSetup } from "./use-canvas-monaco-setup"

beforeEach(() => {
  mockBindings = { "canvas.find": "Ctrl+F" }
  disposeMock.mockClear()
  registerCanvasEditorActionsMock.mockClear()
  registerAllSnippetsMock.mockClear()
  registerEmmetMock.mockClear()
  mountWorkbenchMock
    .mockReset()
    .mockReturnValue({ uri: "canvas:///default/doc-1.ts", dispose: jest.fn() })
  settingsRef.settings.theme = "auto"
})

describe("useCanvasMonacoSetup", () => {
  it("returns an editorOptions snapshot from the store", () => {
    const { result } = renderHook(() => useCanvasMonacoSetup())
    expect(result.current.editorOptions).toEqual({ fontSize: 14 })
    expect(result.current.editorRef).toBeDefined()
    expect(result.current.monacoRef).toBeDefined()
  })

  it("onMount registers snippets, canvas editor keybindings, and mounts the workbench", () => {
    const { result } = renderHook(() =>
      useCanvasMonacoSetup({
        documentId: "doc-1",
        sessionId: "sess-A",
        language: "ts",
        initialContent: "code",
      })
    )
    const editor = { getValue: () => "code" } as never
    const monaco = {
      editor: { setTheme: jest.fn() },
    } as never
    result.current.onMount(editor, monaco)
    expect(registerAllSnippetsMock).toHaveBeenCalledWith(monaco)
    expect(registerEmmetMock).toHaveBeenCalledWith(monaco)
    expect(registerCanvasEditorActionsMock).toHaveBeenCalledWith(editor, monaco, mockBindings)
    expect(mountWorkbenchMock).toHaveBeenCalledWith(
      editor,
      monaco,
      expect.objectContaining({
        surface: "canvas",
        documentId: "doc-1",
        sessionId: "sess-A",
        language: "ts",
        initialContent: "code",
      })
    )
  })

  it("skips workbench mount when documentId is omitted", () => {
    const { result } = renderHook(() => useCanvasMonacoSetup({ language: "ts" }))
    const editor = { getValue: () => "" } as never
    const monaco = { editor: { setTheme: jest.fn() } } as never
    result.current.onMount(editor, monaco)
    expect(mountWorkbenchMock).not.toHaveBeenCalled()
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

  it("applies the theme via monaco.editor.setTheme when the theme pref changes", () => {
    settingsRef.settings.theme = "vs-dark"
    const setTheme = jest.fn()
    const monaco = { editor: { setTheme } } as never
    const { result, rerender } = renderHook(() => useCanvasMonacoSetup())
    result.current.onMount({ getValue: () => "" } as never, monaco)
    // Changing the theme pref + rerender re-runs the theme effect with the
    // monaco ref now populated by onMount.
    settingsRef.settings.theme = "monokai"
    rerender()
    expect(setTheme).toHaveBeenCalledWith("monokai")
  })

  it("re-applies editor keybindings when the bindings change", () => {
    const { result, rerender } = renderHook(() =>
      useCanvasMonacoSetup({ documentId: "doc-1", language: "ts" })
    )
    const editor = { getValue: () => "" } as never
    const monaco = { editor: { setTheme: jest.fn() } } as never
    result.current.onMount(editor, monaco)
    expect(registerCanvasEditorActionsMock).toHaveBeenCalledTimes(1)

    // A rebind changes the bindings object → the effect re-registers.
    mockBindings = { "canvas.find": "Ctrl+Alt+F" }
    rerender()
    expect(registerCanvasEditorActionsMock).toHaveBeenCalledTimes(2)
    expect(disposeMock).toHaveBeenCalled() // previous batch disposed first
  })

  it("disposes the registered editor actions on unmount", () => {
    const { result, unmount } = renderHook(() =>
      useCanvasMonacoSetup({ documentId: "doc-1", language: "ts" })
    )
    result.current.onMount(
      { getValue: () => "" } as never,
      {
        editor: { setTheme: jest.fn() },
      } as never
    )
    disposeMock.mockClear()
    unmount()
    expect(disposeMock).toHaveBeenCalled()
  })
})
