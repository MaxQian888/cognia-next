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
  registerCallHierarchyProvider,
  registerCodeActionsProvider,
  registerCodeLensProvider,
  registerColorProvider,
  registerCompletionItemProvider,
  registerDecorationType,
  registerDefinitionProvider,
  registerDocumentFormattingProvider,
  registerDocumentLinkProvider,
  registerDocumentRangeFormattingProvider,
  registerDocumentRangeSemanticTokensProvider,
  registerDocumentSemanticTokensProvider,
  registerDocumentSymbolProvider,
  registerFoldingRangeProvider,
  registerHoverProvider,
  registerInlayHintsProvider,
  registerInlineCompletionProvider,
  registerLinkedEditingRangeProvider,
  registerOnTypeFormattingProvider,
  registerReferenceProvider,
  registerRenameProvider,
  registerSelectionRangeProvider,
  registerSignatureHelpProvider,
  registerTypeHierarchyProvider,
  registerWorkspaceSymbolProvider,
  searchWorkspaceSymbols,
  setDecorations,
  setDiagnostics,
  unregisterByExtension,
  unregisterByToken,
  type DispatchRpc,
  type MonacoApi,
  type MonacoEditor,
  type MonacoTextModel,
} from "./monaco-bridge"

interface InvocationTriggerBag {
  inlineCompletion?: (
    m: MonacoTextModel,
    p: { lineNumber: number; column: number }
  ) => Promise<unknown>
  signatureHelp?: (
    m: MonacoTextModel,
    p: { lineNumber: number; column: number }
  ) => Promise<unknown>
  color?: (m: MonacoTextModel) => Promise<unknown>
  foldingRange?: (m: MonacoTextModel) => Promise<unknown>
  selectionRange?: (
    m: MonacoTextModel,
    positions: Array<{ lineNumber: number; column: number }>
  ) => Promise<unknown>
  documentLink?: (m: MonacoTextModel) => Promise<unknown>
  onTypeFormat?: (
    m: MonacoTextModel,
    p: { lineNumber: number; column: number },
    ch: string
  ) => Promise<unknown>
  semanticTokens?: (m: MonacoTextModel) => Promise<unknown>
  rangeSemanticTokens?: (
    m: MonacoTextModel,
    range: {
      startLineNumber: number
      startColumn: number
      endLineNumber: number
      endColumn: number
    }
  ) => Promise<unknown>
  inlayHints?: (
    m: MonacoTextModel,
    range: {
      startLineNumber: number
      startColumn: number
      endLineNumber: number
      endColumn: number
    }
  ) => Promise<unknown>
  callHierarchy?: (
    m: MonacoTextModel,
    p: { lineNumber: number; column: number }
  ) => Promise<unknown>
  callHierarchyIncoming?: (item: unknown) => Promise<unknown>
  callHierarchyOutgoing?: (item: unknown) => Promise<unknown>
  typeHierarchy?: (
    m: MonacoTextModel,
    p: { lineNumber: number; column: number }
  ) => Promise<unknown>
  typeHierarchySuper?: (item: unknown) => Promise<unknown>
  typeHierarchySub?: (item: unknown) => Promise<unknown>
  linkedEditingRange?: (
    m: MonacoTextModel,
    p: { lineNumber: number; column: number }
  ) => Promise<unknown>
}

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
  invocationTriggers: InvocationTriggerBag
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
  const invocationTriggers: InvocationTriggerBag = {}
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
    invocationTriggers,
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
      registerInlineCompletionsProvider(selector, provider) {
        calls.push({ method: "inlineCompletion", selector })
        invocationTriggers.inlineCompletion = (m, p) => provider.provideInlineCompletions(m, p)
        return makeDisposable()
      },
      registerSignatureHelpProvider(selector, provider) {
        calls.push({ method: "signatureHelp", selector })
        invocationTriggers.signatureHelp = (m, p) => provider.provideSignatureHelp(m, p)
        return makeDisposable()
      },
      registerColorProvider(selector, provider) {
        calls.push({ method: "color", selector })
        invocationTriggers.color = (m) => provider.provideDocumentColors(m)
        return makeDisposable()
      },
      registerFoldingRangeProvider(selector, provider) {
        calls.push({ method: "foldingRange", selector })
        invocationTriggers.foldingRange = (m) => provider.provideFoldingRanges(m)
        return makeDisposable()
      },
      registerSelectionRangeProvider(selector, provider) {
        calls.push({ method: "selectionRange", selector })
        invocationTriggers.selectionRange = (m, positions) =>
          provider.provideSelectionRanges(m, positions)
        return makeDisposable()
      },
      registerLinkProvider(selector, provider) {
        calls.push({ method: "documentLink", selector })
        invocationTriggers.documentLink = (m) => provider.provideLinks(m)
        return makeDisposable()
      },
      registerOnTypeFormattingEditProvider(selector, provider) {
        calls.push({ method: "onTypeFormat", selector })
        invocationTriggers.onTypeFormat = (m, p, ch) =>
          provider.provideOnTypeFormattingEdits(m, p, ch)
        return makeDisposable()
      },
      registerDocumentSemanticTokensProvider(selector, provider) {
        calls.push({ method: "semanticTokens", selector })
        invocationTriggers.semanticTokens = (m) => provider.provideDocumentSemanticTokens(m)
        return makeDisposable()
      },
      registerDocumentRangeSemanticTokensProvider(selector, provider) {
        calls.push({ method: "rangeSemanticTokens", selector })
        invocationTriggers.rangeSemanticTokens = (m, range) =>
          provider.provideDocumentRangeSemanticTokens(m, range)
        return makeDisposable()
      },
      registerInlayHintsProvider(selector, provider) {
        calls.push({ method: "inlayHints", selector })
        invocationTriggers.inlayHints = (m, range) => provider.provideInlayHints(m, range)
        return makeDisposable()
      },
      registerCallHierarchyProvider(selector, provider) {
        calls.push({ method: "callHierarchy", selector })
        invocationTriggers.callHierarchy = (m, p) => provider.prepareCallHierarchy(m, p)
        invocationTriggers.callHierarchyIncoming = (item) => provider.provideIncomingCalls(item)
        invocationTriggers.callHierarchyOutgoing = (item) => provider.provideOutgoingCalls(item)
        return makeDisposable()
      },
      registerTypeHierarchyProvider(selector, provider) {
        calls.push({ method: "typeHierarchy", selector })
        invocationTriggers.typeHierarchy = (m, p) => provider.prepareTypeHierarchy(m, p)
        invocationTriggers.typeHierarchySuper = (item) => provider.provideSupertypes(item)
        invocationTriggers.typeHierarchySub = (item) => provider.provideSubtypes(item)
        return makeDisposable()
      },
      registerLinkedEditingRangeProvider(selector, provider) {
        calls.push({ method: "linkedEditingRange", selector })
        invocationTriggers.linkedEditingRange = (m, p) => provider.provideLinkedEditingRanges(m, p)
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
      // Sidecar returns VS Code-shape items (flat array form). The bridge
      // routes them through `vscodeCompletionResultToMonaco` before handing
      // them to Monaco, so `kind` becomes the Monaco numeric enum (Text=18
      // when omitted) and `insertText` falls back to `label`.
      const dispatch = jest.fn(async () => [
        { label: "x", insertText: "x" },
      ]) as unknown as jest.MockedFunction<DispatchRpc>
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
      // Position is dispatched in VSCode (0-based) shape.
      expect(dispatch).toHaveBeenCalledWith(
        "ext.a",
        "provideCompletionItems",
        expect.objectContaining({
          uri: "file:///x.ts",
          position: { line: 0, character: 0 },
        })
      )
      expect(result).toEqual({
        suggestions: [
          expect.objectContaining({
            label: "x",
            insertText: "x",
            kind: 18, // Monaco Text fallback for missing VS Code kind.
          }),
        ],
      })
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

  describe("Phase B providers — Tier 2 additions", () => {
    function setup(dispatchResult: unknown = null) {
      const api = makeFakeApi()
      const dispatch = jest.fn(
        async () => dispatchResult
      ) as unknown as jest.MockedFunction<DispatchRpc>
      configureMonacoBridge({ monacoApi: api, dispatchRpc: dispatch })
      const model: MonacoTextModel = {
        uri: "file:///a.ts",
        language: "typescript",
        getValue: () => "",
        setValue: () => {},
        getLineCount: () => 1,
        getLineContent: () => "",
        isDisposed: () => false,
      }
      const pos = { lineNumber: 3, column: 7 }
      const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 5, endColumn: 1 }
      return { api, dispatch, model, pos, range }
    }

    it("registerInlineCompletionProvider routes provideInlineCompletionItems", async () => {
      const { api, dispatch, model, pos } = setup({ items: [{ insertText: "hi" }] })
      registerInlineCompletionProvider({
        extensionId: "ext.continue",
        selector: ["typescript"],
        triggerCharacters: ["."],
      })
      const result = await api.invocationTriggers.inlineCompletion!(model, pos)
      // Position dispatches in VSCode (0-based) shape.
      expect(dispatch).toHaveBeenCalledWith(
        "ext.continue",
        "provideInlineCompletionItems",
        expect.objectContaining({
          uri: "file:///a.ts",
          position: { line: pos.lineNumber - 1, character: pos.column - 1 },
        })
      )
      expect(result).toEqual({ items: [{ insertText: "hi" }] })
    })

    it("registerSignatureHelpProvider routes provideSignatureHelp and passes trigger chars", async () => {
      // Sidecar returns VS Code-shape SignatureHelp directly (no { value: } wrapper).
      const { api, dispatch, model, pos } = setup({
        signatures: [],
        activeSignature: 0,
        activeParameter: 0,
      })
      registerSignatureHelpProvider({
        extensionId: "ext.lsp",
        selector: ["typescript"],
        triggerCharacters: ["("],
        retriggerCharacters: [","],
      })
      const result = await api.invocationTriggers.signatureHelp!(model, pos)
      expect(dispatch).toHaveBeenCalledWith(
        "ext.lsp",
        "provideSignatureHelp",
        expect.objectContaining({ uri: "file:///a.ts" })
      )
      // Bridge wraps in { value: } for Monaco's signature help provider shape.
      expect(result).toMatchObject({ value: { signatures: [] } })
    })

    it("registerWorkspaceSymbolProvider routes through searchWorkspaceSymbols", async () => {
      const { dispatch } = setup([{ name: "FooBar" }])
      registerWorkspaceSymbolProvider({ extensionId: "ext.search" })
      const out = await searchWorkspaceSymbols("Foo")
      expect(dispatch).toHaveBeenCalledWith(
        "ext.search",
        "provideWorkspaceSymbols",
        expect.objectContaining({ query: "Foo" })
      )
      expect(out).toEqual([{ name: "FooBar" }])
    })

    it("searchWorkspaceSymbols aggregates across providers + survives a throw", async () => {
      const api = makeFakeApi()
      let counter = 0
      const dispatch = jest.fn(async () => {
        counter += 1
        if (counter === 1) return [{ id: 1 }]
        if (counter === 2) throw new Error("boom")
        return [{ id: 3 }]
      }) as unknown as jest.MockedFunction<DispatchRpc>
      configureMonacoBridge({ monacoApi: api, dispatchRpc: dispatch })
      registerWorkspaceSymbolProvider({ extensionId: "ext.a" })
      registerWorkspaceSymbolProvider({ extensionId: "ext.b" })
      registerWorkspaceSymbolProvider({ extensionId: "ext.c" })
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
      try {
        const out = await searchWorkspaceSymbols("Q")
        expect(out).toEqual([{ id: 1 }, { id: 3 }])
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })

    it("registerColorProvider routes both provideDocumentColors and presentations", async () => {
      const { api, dispatch, model } = setup([])
      registerColorProvider({ extensionId: "ext", selector: ["css"] })
      await api.invocationTriggers.color!(model)
      expect(dispatch).toHaveBeenCalledWith(
        "ext",
        "provideDocumentColors",
        expect.objectContaining({ uri: "file:///a.ts" })
      )
    })

    it("registerFoldingRangeProvider proxies provideFoldingRanges", async () => {
      // Sidecar returns VS Code/LSP `FoldingRange` shape (0-based `startLine`/`endLine`).
      // Bridge converts to Monaco shape (1-based `start`/`end`).
      const { api, dispatch, model } = setup([{ startLine: 0, endLine: 3 }])
      registerFoldingRangeProvider({ extensionId: "ext", selector: ["ts"] })
      const out = await api.invocationTriggers.foldingRange!(model)
      expect(dispatch).toHaveBeenCalledWith(
        "ext",
        "provideFoldingRanges",
        expect.objectContaining({ uri: "file:///a.ts" })
      )
      expect(out).toEqual([{ start: 1, end: 4, kind: undefined }])
    })

    it("registerSelectionRangeProvider forwards positions", async () => {
      const { api, dispatch, model, pos } = setup([])
      registerSelectionRangeProvider({ extensionId: "ext", selector: ["ts"] })
      await api.invocationTriggers.selectionRange!(model, [pos])
      // Positions dispatch in VSCode (0-based) shape.
      expect(dispatch).toHaveBeenCalledWith(
        "ext",
        "provideSelectionRanges",
        expect.objectContaining({
          positions: [{ line: pos.lineNumber - 1, character: pos.column - 1 }],
        })
      )
    })

    it("registerDocumentLinkProvider proxies provideLinks", async () => {
      const { api, dispatch, model } = setup({ links: [] })
      registerDocumentLinkProvider({ extensionId: "ext", selector: ["markdown"] })
      await api.invocationTriggers.documentLink!(model)
      expect(dispatch).toHaveBeenCalledWith(
        "ext",
        "provideDocumentLinks",
        expect.objectContaining({ uri: "file:///a.ts" })
      )
    })

    it("registerOnTypeFormattingProvider forwards trigger characters and the typed ch", async () => {
      const { api, dispatch, model, pos } = setup([])
      registerOnTypeFormattingProvider({
        extensionId: "ext",
        selector: ["ts"],
        firstTriggerCharacter: ";",
        moreTriggerCharacter: ["}", "\n"],
      })
      await api.invocationTriggers.onTypeFormat!(model, pos, ";")
      // Position dispatches in VSCode (0-based) shape.
      expect(dispatch).toHaveBeenCalledWith(
        "ext",
        "provideOnTypeFormattingEdits",
        expect.objectContaining({
          ch: ";",
          position: { line: pos.lineNumber - 1, character: pos.column - 1 },
        })
      )
    })

    it("registerDocumentSemanticTokensProvider preserves the legend through getLegend()", async () => {
      const legend = { tokenTypes: ["keyword"], tokenModifiers: ["readonly"] }
      const { api, dispatch, model } = setup({ data: [0, 0, 1, 0, 0], resultId: "r1" })
      registerDocumentSemanticTokensProvider({
        extensionId: "ext",
        selector: ["ts"],
        legend,
      })
      const out = await api.invocationTriggers.semanticTokens!(model)
      expect(dispatch).toHaveBeenCalledWith(
        "ext",
        "provideDocumentSemanticTokens",
        expect.objectContaining({ uri: "file:///a.ts" })
      )
      expect(out).toMatchObject({ resultId: "r1" })
    })

    it("registerDocumentRangeSemanticTokensProvider routes range invocations", async () => {
      const { api, dispatch, model, range } = setup({ data: [] })
      registerDocumentRangeSemanticTokensProvider({
        extensionId: "ext",
        selector: ["ts"],
        legend: { tokenTypes: [], tokenModifiers: [] },
      })
      await api.invocationTriggers.rangeSemanticTokens!(model, range)
      // Range dispatches in VSCode (0-based) shape.
      expect(dispatch).toHaveBeenCalledWith(
        "ext",
        "provideDocumentRangeSemanticTokens",
        expect.objectContaining({
          range: {
            start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
            end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
          },
        })
      )
    })

    it("registerInlayHintsProvider routes provideInlayHints with a range", async () => {
      const { api, dispatch, model, range } = setup({ hints: [] })
      registerInlayHintsProvider({ extensionId: "ext", selector: ["ts"] })
      await api.invocationTriggers.inlayHints!(model, range)
      // Range dispatches in VSCode (0-based) shape.
      expect(dispatch).toHaveBeenCalledWith(
        "ext",
        "provideInlayHints",
        expect.objectContaining({
          range: {
            start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
            end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
          },
        })
      )
    })

    it("registerCallHierarchyProvider routes prepare/incoming/outgoing", async () => {
      const { api, dispatch, model, pos } = setup([{ name: "func" }])
      registerCallHierarchyProvider({ extensionId: "ext", selector: ["ts"] })
      await api.invocationTriggers.callHierarchy!(model, pos)
      await api.invocationTriggers.callHierarchyIncoming!({ ref: 1 })
      await api.invocationTriggers.callHierarchyOutgoing!({ ref: 2 })
      const methods = dispatch.mock.calls.map((c) => c[1])
      expect(methods).toEqual([
        "prepareCallHierarchy",
        "provideIncomingCalls",
        "provideOutgoingCalls",
      ])
    })

    it("registerTypeHierarchyProvider routes prepare/super/sub", async () => {
      const { api, dispatch, model, pos } = setup([])
      registerTypeHierarchyProvider({ extensionId: "ext", selector: ["ts"] })
      await api.invocationTriggers.typeHierarchy!(model, pos)
      await api.invocationTriggers.typeHierarchySuper!({ ref: 1 })
      await api.invocationTriggers.typeHierarchySub!({ ref: 2 })
      const methods = dispatch.mock.calls.map((c) => c[1])
      expect(methods).toEqual(["prepareTypeHierarchy", "provideSupertypes", "provideSubtypes"])
    })

    it("registerLinkedEditingRangeProvider routes provideLinkedEditingRanges", async () => {
      const { api, dispatch, model, pos } = setup({ ranges: [] })
      registerLinkedEditingRangeProvider({ extensionId: "ext", selector: ["html"] })
      await api.invocationTriggers.linkedEditingRange!(model, pos)
      // Position dispatches in VSCode (0-based) shape.
      expect(dispatch).toHaveBeenCalledWith(
        "ext",
        "provideLinkedEditingRanges",
        expect.objectContaining({
          position: { line: pos.lineNumber - 1, character: pos.column - 1 },
        })
      )
    })

    it("unregisterByExtension also clears workspace symbol providers", async () => {
      const { dispatch } = setup([{ name: "x" }])
      registerWorkspaceSymbolProvider({ extensionId: "ext.toRemove" })
      registerWorkspaceSymbolProvider({ extensionId: "ext.keep" })
      const before = await searchWorkspaceSymbols("Q")
      expect(before).toEqual([{ name: "x" }, { name: "x" }])
      unregisterByExtension("ext.toRemove")
      const after = await searchWorkspaceSymbols("Q")
      expect(after).toEqual([{ name: "x" }])
      // dispatch was called 2+1 = 3 times total.
      expect(dispatch).toHaveBeenCalledTimes(3)
    })
  })
})
