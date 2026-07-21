import {
  buildWorkbenchUri,
  mountMonacoWorkbench,
  type IDisposable,
  type IMonacoEditor,
  type IMonacoModel,
  type IMonacoUri,
  type MonacoNamespace,
  type MonacoWorkbenchSpec,
} from "./monaco-workbench"

const bridge = jest.requireMock("@/lib/plugin/vscode-shim/monaco-bridge") as {
  notifyEditorMounted: jest.Mock
  notifyEditorUnmounted: jest.Mock
  notifyActiveEditorChanged: jest.Mock
  notifyContentChanged: jest.Mock
  notifySelectionChanged: jest.Mock
}

const lightBindingDispose = jest.fn()
const lightBindingUpdate = jest.fn()
const bindingMock = jest.requireMock("./monaco-context-binding") as {
  bindMonacoEditorContext: jest.Mock
}
const snippetMock = jest.requireMock("@/lib/monaco/snippets") as {
  registerAllSnippets: jest.Mock
  registerEmmetSupport: jest.Mock
}

jest.mock("@/lib/plugin/vscode-shim/monaco-bridge", () => ({
  notifyEditorMounted: jest.fn(),
  notifyEditorUnmounted: jest.fn(),
  notifyActiveEditorChanged: jest.fn(),
  notifyContentChanged: jest.fn(),
  notifySelectionChanged: jest.fn(),
}))

jest.mock("./monaco-context-binding", () => ({
  bindMonacoEditorContext: jest.fn(() => ({
    dispose: lightBindingDispose,
    update: lightBindingUpdate,
  })),
}))

jest.mock("@/lib/monaco/snippets", () => ({
  registerAllSnippets: jest.fn(() => []),
  registerEmmetSupport: jest.fn(() => []),
}))

function makeFakeMonaco(): {
  monaco: MonacoNamespace
  modelByUri: Map<string, IMonacoModel>
  createCalls: Array<{ value: string; language: string; uri?: string }>
} {
  const modelByUri = new Map<string, IMonacoModel>()
  const createCalls: Array<{ value: string; language: string; uri?: string }> = []
  const monaco: MonacoNamespace = {
    Uri: {
      parse(value: string): IMonacoUri {
        const [scheme, rest] = value.split(":///")
        return {
          toString: () => value,
          scheme,
          path: rest ?? "",
        }
      },
    },
    editor: {
      createModel(value, language, uri): IMonacoModel {
        const key = uri?.toString() ?? `inmemory://${createCalls.length}`
        createCalls.push({ value, language, uri: key })
        const listeners = new Set<() => void>()
        let current = value
        const model: IMonacoModel = {
          uri: uri ?? { toString: () => key },
          getLanguageId: () => language,
          getValue: () => current,
          setValue: (v) => {
            current = v
            for (const l of listeners) l()
          },
          getLineCount: () => current.split("\n").length,
          getLineContent: (line) => current.split("\n")[line - 1] ?? "",
          isDisposed: () => false,
          onDidChangeContent(listener: () => void): IDisposable {
            listeners.add(listener)
            return { dispose: () => listeners.delete(listener) }
          },
        }
        modelByUri.set(key, model)
        return model
      },
      getModel(uri): IMonacoModel | null {
        return modelByUri.get(uri.toString()) ?? null
      },
    },
  }
  return { monaco, modelByUri, createCalls }
}

function makeFakeEditor(id = "ed-1"): {
  editor: IMonacoEditor
  triggers: {
    focus: () => void
    blur: () => void
    selection: () => void
  }
  disposeCounts: { focus: number; blur: number; selection: number }
} {
  let currentModel: IMonacoModel | null = null
  const focusListeners = new Set<() => void>()
  const blurListeners = new Set<() => void>()
  const selectionListeners = new Set<() => void>()
  const disposeCounts = { focus: 0, blur: 0, selection: 0 }
  const editor: IMonacoEditor = {
    getId: () => id,
    getModel: () => currentModel,
    setModel: (m) => {
      currentModel = m
    },
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    getSelection: () => ({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    }),
    onDidFocusEditorWidget(listener) {
      focusListeners.add(listener)
      return {
        dispose: () => {
          focusListeners.delete(listener)
          disposeCounts.focus++
        },
      }
    },
    onDidBlurEditorWidget(listener) {
      blurListeners.add(listener)
      return {
        dispose: () => {
          blurListeners.delete(listener)
          disposeCounts.blur++
        },
      }
    },
    onDidChangeCursorSelection(listener) {
      selectionListeners.add(listener)
      return {
        dispose: () => {
          selectionListeners.delete(listener)
          disposeCounts.selection++
        },
      }
    },
    executeEdits: jest.fn(() => true),
    deltaDecorations: jest.fn(() => []),
  }
  return {
    editor,
    triggers: {
      focus: () => focusListeners.forEach((l) => l()),
      blur: () => blurListeners.forEach((l) => l()),
      selection: () => selectionListeners.forEach((l) => l()),
    },
    disposeCounts,
  }
}

beforeEach(() => {
  bridge.notifyEditorMounted.mockClear()
  bridge.notifyEditorUnmounted.mockClear()
  bridge.notifyActiveEditorChanged.mockClear()
  bridge.notifyContentChanged.mockClear()
  bridge.notifySelectionChanged.mockClear()
  bindingMock.bindMonacoEditorContext.mockClear()
  lightBindingDispose.mockClear()
  lightBindingUpdate.mockClear()
})

describe("buildWorkbenchUri", () => {
  it("builds canvas:/// URI with session and document id", () => {
    expect(
      buildWorkbenchUri({
        surface: "canvas",
        sessionId: "sess-1",
        documentId: "doc-7",
        language: "typescript",
        initialContent: "",
      })
    ).toBe("canvas:///sess-1/doc-7.ts")
  })

  it("defaults canvas sessionId to 'default' when omitted", () => {
    expect(
      buildWorkbenchUri({
        surface: "canvas",
        documentId: "doc-7",
        language: "python",
        initialContent: "",
      })
    ).toBe("canvas:///default/doc-7.py")
  })

  it("builds skill:/// URI with skillId and pathSegments", () => {
    expect(
      buildWorkbenchUri({
        surface: "skill",
        skillId: "writer",
        documentId: "skill.md",
        pathSegments: ["scripts", "main.ts"],
        language: "typescript",
        initialContent: "",
      })
    ).toBe("skill:///writer/scripts/main.ts")
  })

  it("falls back skill URI to documentId.ext when no pathSegments", () => {
    expect(
      buildWorkbenchUri({
        surface: "skill",
        skillId: "writer",
        documentId: "skill",
        language: "markdown",
        initialContent: "",
      })
    ).toBe("skill:///writer/skill.md")
  })

  it("builds artifact:/// URI", () => {
    expect(
      buildWorkbenchUri({
        surface: "artifact",
        documentId: "abc",
        language: "javascript",
        initialContent: "",
      })
    ).toBe("artifact:///abc.js")
  })

  it("uses generic {surface}:///{documentId}.{ext} for unknown surfaces", () => {
    expect(
      buildWorkbenchUri({
        surface: "experiment",
        documentId: "node-9",
        language: "json",
        initialContent: "",
      })
    ).toBe("experiment:///node-9.json")
  })

  it("builds a real file:// URI for the `file` surface from absolutePath", () => {
    expect(
      buildWorkbenchUri({
        surface: "file",
        documentId: "src/index.ts",
        absolutePath: "/home/me/project/src/index.ts",
        projectRoot: "/home/me/project",
        language: "typescript",
        initialContent: "",
      })
    ).toBe("file:///home/me/project/src/index.ts")
  })

  it("throws when the `file` surface has no absolutePath", () => {
    expect(() =>
      buildWorkbenchUri({
        surface: "file",
        documentId: "src/index.ts",
        language: "typescript",
        initialContent: "",
      })
    ).toThrow(/absolutePath/)
  })
})

describe("mountMonacoWorkbench", () => {
  const baseSpec: MonacoWorkbenchSpec = {
    surface: "canvas",
    sessionId: "sess-1",
    documentId: "doc-1",
    language: "typescript",
    initialContent: "const x = 1\n",
  }

  beforeEach(() => {
    snippetMock.registerAllSnippets.mockClear()
    snippetMock.registerEmmetSupport.mockClear()
  })

  it("registers shared snippet and Emmet completions for every workbench surface", () => {
    const { monaco } = makeFakeMonaco()
    const { editor } = makeFakeEditor()
    mountMonacoWorkbench(editor, monaco, { ...baseSpec, surface: "skill" })

    expect(snippetMock.registerAllSnippets).toHaveBeenCalledWith(monaco)
    expect(snippetMock.registerEmmetSupport).toHaveBeenCalledWith(monaco)
  })

  it("creates a new model with the workbench URI when none exists", () => {
    const { monaco, createCalls, modelByUri } = makeFakeMonaco()
    const { editor } = makeFakeEditor()
    const handle = mountMonacoWorkbench(editor, monaco, baseSpec)
    expect(handle.uri).toBe("canvas:///sess-1/doc-1.ts")
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]).toEqual({
      value: "const x = 1\n",
      language: "typescript",
      uri: "canvas:///sess-1/doc-1.ts",
    })
    expect(editor.getModel()).toBe(modelByUri.get("canvas:///sess-1/doc-1.ts"))
    handle.dispose()
  })

  it("reuses an existing model when one is already registered at the URI", () => {
    const { monaco, createCalls } = makeFakeMonaco()
    const existing = monaco.editor.createModel(
      "preserved\n",
      "typescript",
      monaco.Uri.parse("canvas:///sess-1/doc-1.ts")
    )
    createCalls.length = 0
    const { editor } = makeFakeEditor()
    mountMonacoWorkbench(editor, monaco, baseSpec)
    expect(createCalls).toHaveLength(0)
    expect(editor.getModel()).toBe(existing)
    expect(existing.getValue()).toBe("preserved\n")
  })

  it("binds to the light editor-context registry", () => {
    const { monaco } = makeFakeMonaco()
    const { editor } = makeFakeEditor("ed-42")
    mountMonacoWorkbench(editor, monaco, baseSpec)
    expect(bindingMock.bindMonacoEditorContext).toHaveBeenCalledWith(
      expect.objectContaining({
        editorId: "ed-42",
        documentId: "doc-1",
        language: "typescript",
        contextId: "canvas",
        editor,
        selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
        cursor: { line: 1, column: 1 },
      })
    )
  })

  it("notifies the vscode-shim bridge with an adapted editor", () => {
    const { monaco } = makeFakeMonaco()
    const { editor } = makeFakeEditor("ed-42")
    mountMonacoWorkbench(editor, monaco, baseSpec)
    expect(bridge.notifyEditorMounted).toHaveBeenCalledTimes(1)
    const adapted = bridge.notifyEditorMounted.mock.calls[0]?.[0] as {
      id: string
      getModel(): { uri: string; language: string } | null
      getPosition(): { lineNumber: number; column: number } | null
    }
    expect(adapted.id).toBe("ed-42")
    expect(adapted.getModel()).toEqual(
      expect.objectContaining({
        uri: "canvas:///sess-1/doc-1.ts",
        language: "typescript",
      })
    )
    expect(adapted.getPosition()).toEqual({ lineNumber: 1, column: 1 })
  })

  it("exposes an adapter that delegates selection / edits / decorations to the editor", () => {
    const { monaco } = makeFakeMonaco()
    const { editor } = makeFakeEditor("ed-adapt")
    mountMonacoWorkbench(editor, monaco, baseSpec)
    const adapted = bridge.notifyEditorMounted.mock.calls[0]?.[0] as {
      getSelection(): unknown
      applyEdits(edits: unknown[]): void
      setDecorations(typeId: string, decorations: unknown[]): void
    }
    expect(adapted.getSelection()).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    })
    adapted.applyEdits([{ range: {}, text: "x" }])
    expect(editor.executeEdits).toHaveBeenCalledWith("workbench", [{ range: {}, text: "x" }])
    adapted.setDecorations("type-1", [{ range: {} }])
    expect(editor.deltaDecorations).toHaveBeenCalledWith([], [{ range: {} }])
  })

  it("adapter getSelection returns null when the editor has no selection", () => {
    const { monaco } = makeFakeMonaco()
    const { editor } = makeFakeEditor("ed-nosel")
    ;(editor as unknown as { getSelection: () => null }).getSelection = () => null
    mountMonacoWorkbench(editor, monaco, baseSpec)
    const adapted = bridge.notifyEditorMounted.mock.calls[0]?.[0] as { getSelection(): unknown }
    expect(adapted.getSelection()).toBeNull()
  })

  it("forwards focus → notifyActiveEditorChanged(editorId)", () => {
    const { monaco } = makeFakeMonaco()
    const { editor, triggers } = makeFakeEditor("ed-7")
    mountMonacoWorkbench(editor, monaco, baseSpec)
    triggers.focus()
    expect(bridge.notifyActiveEditorChanged).toHaveBeenLastCalledWith("ed-7")
  })

  it("forwards blur → notifyActiveEditorChanged(null)", () => {
    const { monaco } = makeFakeMonaco()
    const { editor, triggers } = makeFakeEditor("ed-7")
    mountMonacoWorkbench(editor, monaco, baseSpec)
    triggers.blur()
    expect(bridge.notifyActiveEditorChanged).toHaveBeenLastCalledWith(null)
  })

  it("forwards model content change → notifyContentChanged(editorId)", () => {
    const { monaco } = makeFakeMonaco()
    const { editor } = makeFakeEditor("ed-7")
    mountMonacoWorkbench(editor, monaco, baseSpec)
    editor.getModel()?.setValue("changed\n")
    expect(bridge.notifyContentChanged).toHaveBeenLastCalledWith("ed-7")
  })

  it("forwards selection change → notifySelectionChanged(editorId)", () => {
    const { monaco } = makeFakeMonaco()
    const { editor, triggers } = makeFakeEditor("ed-7")
    mountMonacoWorkbench(editor, monaco, baseSpec)
    triggers.selection()
    expect(bridge.notifySelectionChanged).toHaveBeenLastCalledWith("ed-7")
    // The registry binding is patched with the fresh selection/cursor too.
    expect(lightBindingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
        cursor: { line: 1, column: 1 },
      })
    )
  })

  it("dispose() tears down all listeners, unmounts the bridge, releases the light binding", () => {
    const { monaco } = makeFakeMonaco()
    const { editor, disposeCounts } = makeFakeEditor("ed-7")
    const handle = mountMonacoWorkbench(editor, monaco, baseSpec)
    handle.dispose()
    expect(disposeCounts.focus).toBe(1)
    expect(disposeCounts.blur).toBe(1)
    expect(disposeCounts.selection).toBe(1)
    expect(bridge.notifyEditorUnmounted).toHaveBeenCalledWith("ed-7")
    expect(lightBindingDispose).toHaveBeenCalledTimes(1)
  })

  it("dispose() is idempotent", () => {
    const { monaco } = makeFakeMonaco()
    const { editor } = makeFakeEditor("ed-7")
    const handle = mountMonacoWorkbench(editor, monaco, baseSpec)
    handle.dispose()
    handle.dispose()
    expect(bridge.notifyEditorUnmounted).toHaveBeenCalledTimes(1)
    expect(lightBindingDispose).toHaveBeenCalledTimes(1)
  })

  it("mounts the `file` surface with a real file:// model URI and file context", () => {
    const { monaco, createCalls } = makeFakeMonaco()
    const { editor } = makeFakeEditor("ed-file")
    const handle = mountMonacoWorkbench(editor, monaco, {
      surface: "file",
      documentId: "src/a.ts",
      absolutePath: "/proj/src/a.ts",
      projectRoot: "/proj",
      language: "typescript",
      initialContent: "export const a = 1\n",
    })
    expect(handle.uri).toBe("file:///proj/src/a.ts")
    expect(createCalls[0]?.uri).toBe("file:///proj/src/a.ts")
    expect(bindingMock.bindMonacoEditorContext).toHaveBeenCalledWith(
      expect.objectContaining({ contextId: "file", documentId: "src/a.ts" })
    )
    handle.dispose()
  })
})
