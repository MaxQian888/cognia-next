import {
  __resetMonacoBridgeForTesting,
  configureMonacoBridge,
  getActiveEditorSnapshot,
  getEditorById,
  notifyActiveEditorChanged,
  notifyContentChanged,
  notifyEditorMounted,
  notifyEditorUnmounted,
  notifySelectionChanged,
  onActiveEditorChanged,
  onEditorChange,
  registerCodeActionsProvider,
  registerCodeLensProvider,
  registerCompletionItemProvider,
  registerDecorationType,
  registerDefinitionProvider,
  registerDocumentFormattingProvider,
  registerDocumentRangeFormattingProvider,
  registerDocumentSymbolProvider,
  registerHoverProvider,
  registerReferenceProvider,
  registerRenameProvider,
  setDecorations,
  setDiagnostics,
  unregisterByExtension,
  unregisterByToken,
  type DispatchRpc,
  type MonacoApi,
  type MonacoEditor,
  type MonacoTextModel,
} from "./monaco-bridge"

function makeFakeApi(): MonacoApi & {
  calls: Array<{ method: string; selector: string | string[] }>
  disposers: Array<jest.Mock>
  triggerCompletion?: (
    model: MonacoTextModel,
    position: { lineNumber: number; column: number }
  ) => Promise<unknown>
  triggerHover?: (
    model: MonacoTextModel,
    position: { lineNumber: number; column: number }
  ) => Promise<unknown>
  triggerDefinition?: (
    model: MonacoTextModel,
    position: { lineNumber: number; column: number }
  ) => Promise<unknown>
  triggerFormatting?: (model: MonacoTextModel) => Promise<unknown>
  triggerSetModelMarkers?: jest.Mock
} {
  const calls: Array<{ method: string; selector: string | string[] }> = []
  const disposers: jest.Mock[] = []
  let triggerCompletion:
    | ((m: MonacoTextModel, p: { lineNumber: number; column: number }) => Promise<unknown>)
    | undefined
  let triggerHover:
    | ((m: MonacoTextModel, p: { lineNumber: number; column: number }) => Promise<unknown>)
    | undefined
  let triggerDefinition:
    | ((m: MonacoTextModel, p: { lineNumber: number; column: number }) => Promise<unknown>)
    | undefined
  let triggerFormatting: ((m: MonacoTextModel) => Promise<unknown>) | undefined
  const setModelMarkers = jest.fn()
  const makeDisposable = () => {
    const dispose = jest.fn()
    disposers.push(dispose)
    return { dispose }
  }
  return {
    calls,
    disposers,
    triggerSetModelMarkers: setModelMarkers,
    get triggerCompletion() {
      return triggerCompletion
    },
    get triggerHover() {
      return triggerHover
    },
    get triggerDefinition() {
      return triggerDefinition
    },
    get triggerFormatting() {
      return triggerFormatting
    },
    languages: {
      registerCompletionItemProvider(selector, provider) {
        calls.push({ method: "completion", selector })
        triggerCompletion = (m, p) => provider.provideCompletionItems(m, p)
        return makeDisposable()
      },
      registerHoverProvider(selector, provider) {
        calls.push({ method: "hover", selector })
        triggerHover = (m, p) => provider.provideHover(m, p)
        return makeDisposable()
      },
      registerDefinitionProvider(selector, provider) {
        calls.push({ method: "definition", selector })
        triggerDefinition = (m, p) => provider.provideDefinition(m, p)
        return makeDisposable()
      },
      registerReferenceProvider(selector) {
        calls.push({ method: "references", selector })
        return makeDisposable()
      },
      registerDocumentFormattingEditProvider(selector, provider) {
        calls.push({ method: "format", selector })
        triggerFormatting = (m) => provider.provideDocumentFormattingEdits(m)
        return makeDisposable()
      },
      registerDocumentRangeFormattingEditProvider(selector) {
        calls.push({ method: "rangeFormat", selector })
        return makeDisposable()
      },
      registerCodeLensProvider(selector) {
        calls.push({ method: "codeLens", selector })
        return makeDisposable()
      },
      registerCodeActionProvider(selector) {
        calls.push({ method: "codeAction", selector })
        return makeDisposable()
      },
      registerRenameProvider(selector) {
        calls.push({ method: "rename", selector })
        return makeDisposable()
      },
      registerDocumentSymbolProvider(selector) {
        calls.push({ method: "documentSymbol", selector })
        return makeDisposable()
      },
    },
    editor: {
      setModelMarkers,
    },
  }
}

function makeFakeEditor(id: string, uri: string, language = "typescript"): MonacoEditor {
  const model: MonacoTextModel = {
    uri,
    language,
    getValue: () => "code",
    setValue: () => {},
    getLineCount: () => 1,
    getLineContent: () => "code",
    isDisposed: () => false,
  }
  return {
    id,
    getModel: () => model,
    getPosition: () => ({ lineNumber: 1, column: 1 }),
    getSelection: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }),
    applyEdits: jest.fn(),
    setDecorations: jest.fn(),
  }
}

// jest.fn() narrows the return generic to the concrete type returned by the
// implementation (e.g. `Promise<null>`), which doesn't unify with the
// generic `DispatchRpc<T>`. Cast through unknown so the mock satisfies the
// declared parameter signature without losing call-tracking.
const fakeDispatch = jest.fn(async () => null) as unknown as DispatchRpc

describe("monaco-bridge", () => {
  beforeEach(() => __resetMonacoBridgeForTesting())

  describe("configuration", () => {
    it("throws when providers register before configuration", () => {
      expect(() =>
        registerCompletionItemProvider({
          extensionId: "x",
          selector: ["typescript"],
        })
      ).toThrow(/not configured/i)
    })
  })

  describe("editor lifecycle", () => {
    it("tracks mounted editors and exposes the active one", () => {
      const api = makeFakeApi()
      configureMonacoBridge({ monacoApi: api, dispatchRpc: fakeDispatch })
      const editor = makeFakeEditor("e1", "file:///foo.ts")
      notifyEditorMounted(editor)
      notifyActiveEditorChanged("e1")
      const snapshot = getActiveEditorSnapshot()
      expect(snapshot?.editorId).toBe("e1")
      expect(snapshot?.uri).toBe("file:///foo.ts")
      expect(snapshot?.language).toBe("typescript")
      expect(getEditorById("e1")).toBe(editor)
    })

    it("emits active-editor-changed events", async () => {
      const api = makeFakeApi()
      configureMonacoBridge({ monacoApi: api, dispatchRpc: fakeDispatch })
      const editor = makeFakeEditor("e1", "file:///foo.ts")
      notifyEditorMounted(editor)
      const events: Array<MonacoEditor | null> = []
      const dispose = onActiveEditorChanged((e) => events.push(e))
      notifyActiveEditorChanged("e1")
      notifyActiveEditorChanged(null)
      await new Promise((r) => setTimeout(r, 0))
      expect(events).toEqual([editor, null])
      dispose()
    })

    it("emits selection + content + open + close change events", async () => {
      const api = makeFakeApi()
      configureMonacoBridge({ monacoApi: api, dispatchRpc: fakeDispatch })
      const editor = makeFakeEditor("e1", "file:///foo.ts")
      const events: string[] = []
      const dispose = onEditorChange((e) => events.push(`${e.kind}:${e.uri}`))
      notifyEditorMounted(editor)
      notifySelectionChanged("e1")
      notifyContentChanged("e1")
      notifyEditorUnmounted("e1")
      await new Promise((r) => setTimeout(r, 0))
      expect(events).toEqual([
        "open:file:///foo.ts",
        "change-selection:file:///foo.ts",
        "change-content:file:///foo.ts",
        "close:file:///foo.ts",
      ])
      dispose()
    })

    it("clears the active editor when it unmounts", () => {
      const api = makeFakeApi()
      configureMonacoBridge({ monacoApi: api, dispatchRpc: fakeDispatch })
      notifyEditorMounted(makeFakeEditor("e1", "file:///foo.ts"))
      notifyActiveEditorChanged("e1")
      notifyEditorUnmounted("e1")
      expect(getActiveEditorSnapshot()).toBeNull()
    })

    it("ignores selection/content notifications for unknown editors", () => {
      const api = makeFakeApi()
      configureMonacoBridge({ monacoApi: api, dispatchRpc: fakeDispatch })
      expect(() => notifySelectionChanged("nope")).not.toThrow()
      expect(() => notifyContentChanged("nope")).not.toThrow()
      expect(() => notifyEditorUnmounted("nope")).not.toThrow()
    })
  })

  describe("provider registrations", () => {
    it("registers a completion provider and proxies invocations to the sidecar", async () => {
      const api = makeFakeApi()
      const dispatch = jest.fn(async () => ({
        suggestions: [{ label: "x", insertText: "x" }],
      })) as unknown as jest.MockedFunction<DispatchRpc>
      configureMonacoBridge({ monacoApi: api, dispatchRpc: dispatch })
      registerCompletionItemProvider({
        extensionId: "ext.a",
        selector: ["typescript"],
        triggerCharacters: ["."],
      })
      expect(api.calls[0]).toEqual({ method: "completion", selector: ["typescript"] })

      const model: MonacoTextModel = {
        uri: "file:///x.ts",
        language: "typescript",
        getValue: () => "",
        setValue: () => {},
        getLineCount: () => 1,
        getLineContent: () => "",
        isDisposed: () => false,
      }
      const result = await api.triggerCompletion!(model, { lineNumber: 1, column: 1 })
      expect(dispatch).toHaveBeenCalledWith(
        "ext.a",
        "provideCompletionItems",
        expect.objectContaining({ uri: "file:///x.ts" })
      )
      expect(result).toEqual({ suggestions: [{ label: "x", insertText: "x" }] })
    })

    it("hover/definition/formatting providers route through dispatchRpc", async () => {
      const api = makeFakeApi()
      const dispatch = jest.fn(async () => null) as unknown as jest.MockedFunction<DispatchRpc>
      configureMonacoBridge({ monacoApi: api, dispatchRpc: dispatch })
      registerHoverProvider({ extensionId: "ext", selector: ["typescript"] })
      registerDefinitionProvider({ extensionId: "ext", selector: ["typescript"] })
      registerDocumentFormattingProvider({ extensionId: "ext", selector: ["typescript"] })

      const model: MonacoTextModel = {
        uri: "file:///y.ts",
        language: "typescript",
        getValue: () => "",
        setValue: () => {},
        getLineCount: () => 1,
        getLineContent: () => "",
        isDisposed: () => false,
      }
      await api.triggerHover!(model, { lineNumber: 1, column: 1 })
      await api.triggerDefinition!(model, { lineNumber: 1, column: 1 })
      await api.triggerFormatting!(model)

      const methods = dispatch.mock.calls.map((args) => args[1])
      expect(methods).toEqual([
        "provideHover",
        "provideDefinition",
        "provideDocumentFormattingEdits",
      ])
    })

    it("supports the remaining provider kinds without crashing", () => {
      const api = makeFakeApi()
      configureMonacoBridge({ monacoApi: api, dispatchRpc: fakeDispatch })
      registerReferenceProvider({ extensionId: "x", selector: ["js"] })
      registerDocumentRangeFormattingProvider({ extensionId: "x", selector: ["js"] })
      registerCodeLensProvider({ extensionId: "x", selector: ["js"] })
      registerCodeActionsProvider({ extensionId: "x", selector: ["js"] })
      registerRenameProvider({ extensionId: "x", selector: ["js"] })
      registerDocumentSymbolProvider({ extensionId: "x", selector: ["js"] })
      const methods = api.calls.map((c) => c.method)
      expect(methods).toEqual(
        expect.arrayContaining([
          "references",
          "rangeFormat",
          "codeLens",
          "codeAction",
          "rename",
          "documentSymbol",
        ])
      )
    })
  })

  describe("registration tokens", () => {
    it("unregisterByToken disposes the underlying Monaco registration", () => {
      const api = makeFakeApi()
      configureMonacoBridge({ monacoApi: api, dispatchRpc: fakeDispatch })
      const { token } = registerCompletionItemProvider({
        extensionId: "x",
        selector: ["ts"],
      })
      expect(unregisterByToken(token)).toBe(true)
      expect(api.disposers[0]).toHaveBeenCalled()
      // Idempotent.
      expect(unregisterByToken(token)).toBe(false)
    })

    it("unregisterByExtension cleans up every token for an extension", () => {
      const api = makeFakeApi()
      configureMonacoBridge({ monacoApi: api, dispatchRpc: fakeDispatch })
      registerCompletionItemProvider({ extensionId: "ext.a", selector: ["ts"] })
      registerHoverProvider({ extensionId: "ext.a", selector: ["ts"] })
      registerCompletionItemProvider({ extensionId: "ext.b", selector: ["ts"] })
      const removed = unregisterByExtension("ext.a")
      expect(removed).toBe(2)
    })

    it("survives a disposable that throws", () => {
      const api = makeFakeApi()
      configureMonacoBridge({ monacoApi: api, dispatchRpc: fakeDispatch })
      const { token } = registerCompletionItemProvider({
        extensionId: "x",
        selector: ["ts"],
      })
      api.disposers[0]!.mockImplementation(() => {
        throw new Error("dispose boom")
      })
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        expect(unregisterByToken(token)).toBe(true)
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })
  })

  describe("diagnostics + decorations", () => {
    it("setDiagnostics forwards to monaco.editor.setModelMarkers", () => {
      const api = makeFakeApi()
      configureMonacoBridge({ monacoApi: api, dispatchRpc: fakeDispatch })
      const editor = makeFakeEditor("e1", "file:///x.ts")
      notifyEditorMounted(editor)
      setDiagnostics({
        extensionId: "ext.eslint",
        uri: "file:///x.ts",
        markers: [
          {
            severity: "error",
            message: "boom",
            range: {
              startLineNumber: 1,
              startColumn: 1,
              endLineNumber: 1,
              endColumn: 5,
            },
          },
        ],
      })
      expect(api.triggerSetModelMarkers).toHaveBeenCalledWith(
        editor.getModel(),
        "ext.eslint",
        expect.any(Array)
      )
    })

    it("setDiagnostics silently no-ops when no editor has the URI", () => {
      const api = makeFakeApi()
      configureMonacoBridge({ monacoApi: api, dispatchRpc: fakeDispatch })
      setDiagnostics({ extensionId: "x", uri: "file:///nope.ts", markers: [] })
      expect(api.triggerSetModelMarkers).not.toHaveBeenCalled()
    })

    it("registerDecorationType returns a stable typeId", () => {
      const api = makeFakeApi()
      configureMonacoBridge({ monacoApi: api, dispatchRpc: fakeDispatch })
      const { typeId } = registerDecorationType({
        extensionId: "ext.gitlens",
        options: { className: "blame-line" },
      })
      expect(typeId).toBeDefined()
    })

    it("setDecorations forwards to the editor", () => {
      const api = makeFakeApi()
      configureMonacoBridge({ monacoApi: api, dispatchRpc: fakeDispatch })
      const editor = makeFakeEditor("e1", "file:///x.ts")
      notifyEditorMounted(editor)
      const { typeId } = registerDecorationType({
        extensionId: "ext.gitlens",
        options: { className: "blame-line" },
      })
      setDecorations({
        editorId: "e1",
        typeId,
        decorations: [
          {
            range: {
              startLineNumber: 1,
              startColumn: 1,
              endLineNumber: 1,
              endColumn: 1,
            },
            options: { isWholeLine: true },
          },
        ],
      })
      expect(editor.setDecorations).toHaveBeenCalledWith(typeId, expect.any(Array))
    })

    it("setDecorations silently no-ops for an unknown editor", () => {
      const api = makeFakeApi()
      configureMonacoBridge({ monacoApi: api, dispatchRpc: fakeDispatch })
      const { typeId } = registerDecorationType({
        extensionId: "ext.gitlens",
        options: {},
      })
      // Should not throw.
      setDecorations({ editorId: "nope", typeId, decorations: [] })
    })

    it("unregisterByExtension also cleans up decoration types", () => {
      const api = makeFakeApi()
      configureMonacoBridge({ monacoApi: api, dispatchRpc: fakeDispatch })
      registerDecorationType({ extensionId: "ext.a", options: { className: "x" } })
      registerDecorationType({ extensionId: "ext.b", options: { className: "y" } })
      unregisterByExtension("ext.a")
      // Re-registering after cleanup should work.
      const { typeId } = registerDecorationType({
        extensionId: "ext.a",
        options: { className: "z" },
      })
      expect(typeId).toBeDefined()
    })
  })
})
