import {
  __resetMonacoBridgeForTesting,
  configureMonacoBridge,
  disposeLanguageConfiguration,
  getActiveEditorId,
  getActiveEditorSnapshot,
  getDiagnostics,
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
  registerDeclarationProvider,
  registerDecorationType,
  registerDefinitionProvider,
  registerDocumentFormattingProvider,
  registerDocumentHighlightProvider,
  registerDocumentLinkProvider,
  registerDocumentRangeFormattingProvider,
  registerDocumentRangeSemanticTokensProvider,
  registerDocumentSemanticTokensProvider,
  registerDocumentSymbolProvider,
  registerFoldingRangeProvider,
  registerHoverProvider,
  registerImplementationProvider,
  registerInlayHintsProvider,
  registerInlineCompletionProvider,
  registerLinkedEditingRangeProvider,
  registerOnTypeFormattingProvider,
  registerReferenceProvider,
  registerRenameProvider,
  registerSelectionRangeProvider,
  registerSignatureHelpProvider,
  registerTypeDefinitionProvider,
  registerTypeHierarchyProvider,
  registerWorkspaceSymbolProvider,
  reviveRegExps,
  searchWorkspaceSymbols,
  setDecorations,
  setDiagnostics,
  setDocumentLanguage,
  setLanguageConfiguration,
  unregisterByExtension,
  unregisterByToken,
  type DispatchRpc,
  type MonacoApi,
  type MonacoCancellationToken,
  type MonacoEditor,
  type MonacoMarker,
  type MonacoRegistrarName,
  type MonacoTextModel,
} from "./monaco-bridge"

type ProviderObject = Record<string, (...args: unknown[]) => unknown>

/** Standalone Monaco 0.57 has no call- or type-hierarchy registrars. */
const MISSING_IN_MONACO = new Set<MonacoRegistrarName>([
  "registerCallHierarchyProvider",
  "registerTypeHierarchyProvider",
])

function makeFakeApi(openUris: string[] = []) {
  const registered: Array<{
    registrar: MonacoRegistrarName
    selector: unknown
    provider: ProviderObject
    dispose: jest.Mock
  }> = []
  const languages = new Proxy({} as MonacoApi["languages"], {
    get(_target, name: string) {
      if (MISSING_IN_MONACO.has(name as MonacoRegistrarName)) return undefined
      return (selector: unknown, provider: ProviderObject) => {
        const dispose = jest.fn()
        registered.push({ registrar: name as MonacoRegistrarName, selector, provider, dispose })
        return { dispose }
      }
    },
  })
  const open = new Set(openUris)
  const setModelMarkers = jest.fn((uri: string, _owner: string, _markers: MonacoMarker[]) =>
    open.has(uri)
  )
  const languageConfigurations: Array<{
    languageId: string
    configuration: unknown
    dispose: jest.Mock
  }> = []
  const setModelLanguage = jest.fn((uri: string, _languageId: string) => open.has(uri))
  const api: MonacoApi = {
    languages,
    editor: { setModelMarkers },
    parseUri: (uri) => ({ parsed: uri }),
    setLanguageConfiguration: (languageId, configuration) => {
      const dispose = jest.fn()
      languageConfigurations.push({ languageId, configuration, dispose })
      return { dispose }
    },
    setModelLanguage,
  }
  /** The provider object the last registration through `registrar` handed Monaco. */
  const providerOf = (registrar: MonacoRegistrarName): ProviderObject => {
    const entry = [...registered].reverse().find((r) => r.registrar === registrar)
    if (!entry) throw new Error(`nothing registered through ${registrar}`)
    return entry.provider
  }
  return {
    api,
    registered,
    providerOf,
    setModelMarkers,
    setModelLanguage,
    languageConfigurations,
    open,
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

/** A model as Monaco passes providers: a `Uri` object, a version, a word lookup. */
const model = {
  uri: { toString: () => "file:///a.ts" },
  getVersionId: () => 7,
  getWordUntilPosition: () => ({ startColumn: 3, endColumn: 6 }),
}
const at = { lineNumber: 2, column: 6 }
const wireAt = { line: 1, character: 5 }
const doc = { token: "host-token", uri: "file:///a.ts", version: 7 }
const range1 = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }
const wireRange1 = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }

function setup(answer: unknown = null, openUris: string[] = []) {
  const fake = makeFakeApi(openUris)
  const dispatch = jest.fn(async () => answer) as unknown as jest.MockedFunction<DispatchRpc>
  configureMonacoBridge({ monacoApi: fake.api, dispatchRpc: dispatch })
  const base = { extensionId: "ext.a", selector: ["typescript"], token: "host-token" }
  return { ...fake, dispatch, base }
}

const fakeDispatch = jest.fn(async () => null) as unknown as DispatchRpc

beforeEach(() => __resetMonacoBridgeForTesting())

describe("configuration", () => {
  it("throws when providers register before configuration", () => {
    expect(() => registerCompletionItemProvider({ extensionId: "x", selector: ["ts"] })).toThrow(
      /not configured/i
    )
  })
})

describe("editor lifecycle", () => {
  it("tracks mounted editors and exposes the active one", () => {
    configureMonacoBridge({ monacoApi: makeFakeApi().api, dispatchRpc: fakeDispatch })
    const editor = makeFakeEditor("e1", "file:///foo.ts")
    notifyEditorMounted(editor)
    notifyActiveEditorChanged("e1")
    expect(getActiveEditorSnapshot()).toMatchObject({
      editorId: "e1",
      uri: "file:///foo.ts",
      language: "typescript",
    })
    expect(getActiveEditorId()).toBe("e1")
    expect(getEditorById("e1")).toBe(editor)
  })

  it("emits active-editor-changed events", async () => {
    configureMonacoBridge({ monacoApi: makeFakeApi().api, dispatchRpc: fakeDispatch })
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

  it("emits selection, content, open and close events", async () => {
    configureMonacoBridge({ monacoApi: makeFakeApi().api, dispatchRpc: fakeDispatch })
    const events: string[] = []
    const dispose = onEditorChange((e) => events.push(`${e.kind}:${e.uri}`))
    notifyEditorMounted(makeFakeEditor("e1", "file:///foo.ts"))
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
    configureMonacoBridge({ monacoApi: makeFakeApi().api, dispatchRpc: fakeDispatch })
    notifyEditorMounted(makeFakeEditor("e1", "file:///foo.ts"))
    notifyActiveEditorChanged("e1")
    notifyEditorUnmounted("e1")
    expect(getActiveEditorSnapshot()).toBeNull()
    expect(getActiveEditorId()).toBeNull()
  })

  it("ignores notifications for unknown editors", () => {
    configureMonacoBridge({ monacoApi: makeFakeApi().api, dispatchRpc: fakeDispatch })
    expect(() => notifySelectionChanged("nope")).not.toThrow()
    expect(() => notifyContentChanged("nope")).not.toThrow()
    expect(() => notifyEditorUnmounted("nope")).not.toThrow()
  })
})

describe("provider calls", () => {
  it("completion: sends the host's token, the document version and context, and fills the range", async () => {
    const { base, dispatch, providerOf } = setup({
      isIncomplete: true,
      items: [
        { label: "foo", kind: 3 },
        { label: "bar", range: wireRange1 },
      ],
    })
    const registration = registerCompletionItemProvider({ ...base, triggerCharacters: ["."] })
    expect(registration).toMatchObject({ token: "host-token", supported: true })
    const provider = providerOf("registerCompletionItemProvider")
    expect(provider.triggerCharacters).toEqual(["."])
    const result = (await provider.provideCompletionItems(model, at, {
      triggerKind: 1,
      triggerCharacter: ".",
    })) as { suggestions: Array<{ range: unknown; kind: number }>; incomplete: boolean }
    expect(dispatch).toHaveBeenCalledWith(
      "ext.a",
      "provideCompletionItems",
      { ...doc, position: wireAt, context: { triggerKind: 1, triggerCharacter: "." } },
      undefined
    )
    expect(result.incomplete).toBe(true)
    // No range: the word before the cursor, as VS Code does.
    expect(result.suggestions[0].range).toEqual({
      startLineNumber: 2,
      startColumn: 3,
      endLineNumber: 2,
      endColumn: 6,
    })
    expect(result.suggestions[1].range).toEqual(range1)
  })

  it("hover: contents become Markdown strings Monaco renders", async () => {
    const { base, providerOf } = setup({
      contents: [{ kind: "markdown", value: "**x**" }, "plain"],
    })
    registerHoverProvider(base)
    const result = (await providerOf("registerHoverProvider").provideHover(model, at)) as {
      contents: Array<{ value: string }>
    }
    expect(result.contents).toEqual([{ value: "**x**" }, { value: "plain" }])
  })

  it.each([
    [registerDefinitionProvider, "registerDefinitionProvider", "provideDefinition"],
    [registerDeclarationProvider, "registerDeclarationProvider", "provideDeclaration"],
    [registerTypeDefinitionProvider, "registerTypeDefinitionProvider", "provideTypeDefinition"],
    [registerImplementationProvider, "registerImplementationProvider", "provideImplementation"],
  ] as const)("%p answers with Monaco URIs", async (register, registrar, method) => {
    const { base, dispatch, providerOf } = setup({ uri: "file:///b.ts", range: wireRange1 })
    register(base)
    const result = await providerOf(registrar)[method](model, at)
    expect(dispatch).toHaveBeenCalledWith("ext.a", method, { ...doc, position: wireAt }, undefined)
    expect(result).toEqual([{ uri: { parsed: "file:///b.ts" }, range: range1 }])
  })

  it("references pass includeDeclaration", async () => {
    const { base, dispatch, providerOf } = setup([])
    registerReferenceProvider(base)
    await providerOf("registerReferenceProvider").provideReferences(model, at, {
      includeDeclaration: false,
    })
    expect(dispatch.mock.calls[0][2]).toMatchObject({ context: { includeDeclaration: false } })
  })

  it("document highlights map LSP kinds to Monaco's", async () => {
    const { base, providerOf } = setup([{ range: wireRange1, kind: 3 }, { range: wireRange1 }])
    registerDocumentHighlightProvider(base)
    const result = await providerOf("registerDocumentHighlightProvider").provideDocumentHighlights(
      model,
      at
    )
    expect(result).toEqual([
      { range: range1, kind: 2 },
      { range: range1, kind: 0 },
    ])
  })

  it("formatting passes Monaco's options; on-type formatting registers its trigger characters", async () => {
    const { base, dispatch, providerOf } = setup([{ range: wireRange1, newText: "x" }])
    registerDocumentFormattingProvider(base)
    registerDocumentRangeFormattingProvider(base)
    registerOnTypeFormattingProvider({
      ...base,
      firstTriggerCharacter: ";",
      moreTriggerCharacter: ["}"],
    })
    const options = { tabSize: 4, insertSpaces: false }
    expect(
      await providerOf("registerDocumentFormattingEditProvider").provideDocumentFormattingEdits(
        model,
        options
      )
    ).toEqual([{ range: range1, text: "x" }])
    await providerOf(
      "registerDocumentRangeFormattingEditProvider"
    ).provideDocumentRangeFormattingEdits(model, range1, options)
    const onType = providerOf("registerOnTypeFormattingEditProvider")
    expect(onType.autoFormatTriggerCharacters).toEqual([";", "}"])
    await onType.provideOnTypeFormattingEdits(model, at, ";", options)
    expect(dispatch.mock.calls.map((call) => call[2])).toEqual([
      { ...doc, options },
      { ...doc, range: wireRange1, options },
      { ...doc, position: wireAt, ch: ";", options },
    ])
  })

  it("code actions: markers go out as diagnostics, actions come back as a CodeActionList", async () => {
    const { base, dispatch, providerOf } = setup([
      {
        title: "Fix it",
        kind: "quickfix",
        isPreferred: true,
        edit: { changes: { "file:///a.ts": [{ range: wireRange1, newText: "y" }] } },
      },
      { title: "Run", command: "ext.run", arguments: [1] },
    ])
    registerCodeActionsProvider(base)
    const result = (await providerOf("registerCodeActionProvider").provideCodeActions(
      model,
      range1,
      {
        markers: [{ severity: 8, message: "bad", ...range1 }],
        only: "quickfix",
        trigger: 2,
      }
    )) as { actions: unknown[]; dispose: () => void }
    expect(dispatch.mock.calls[0][2]).toMatchObject({
      context: {
        diagnostics: [{ range: wireRange1, severity: 0, message: "bad" }],
        only: "quickfix",
        triggerKind: 2,
      },
    })
    expect(result.actions).toEqual([
      {
        title: "Fix it",
        kind: "quickfix",
        isPreferred: true,
        edit: {
          edits: [
            {
              resource: { parsed: "file:///a.ts" },
              textEdit: { range: range1, text: "y" },
              versionId: undefined,
            },
          ],
        },
      },
      { title: "Run", command: { id: "ext.run", title: "Run", arguments: [1] } },
    ])
    expect(typeof result.dispose).toBe("function")
  })

  it("rename: edits become Monaco's workspace edit, and a rejected prepare carries its reason", async () => {
    const { base, dispatch, providerOf } = setup([{ range: wireRange1, newText: "renamed" }])
    registerRenameProvider(base)
    const provider = providerOf("registerRenameProvider")
    expect(await provider.provideRenameEdits(model, at, "renamed")).toEqual({
      edits: [
        {
          resource: { parsed: "file:///a.ts" },
          textEdit: { range: range1, text: "renamed" },
          versionId: undefined,
        },
      ],
    })
    dispatch.mockResolvedValueOnce({ rejectReason: "Not a symbol" })
    expect(await provider.resolveRenameLocation(model, at)).toMatchObject({
      rejectReason: "Not a symbol",
    })
    dispatch.mockResolvedValueOnce({ range: wireRange1, text: "abc" })
    expect(await provider.resolveRenameLocation(model, at)).toEqual({ range: range1, text: "abc" })
    dispatch.mockResolvedValueOnce(null)
    expect(await provider.resolveRenameLocation(model, at)).toBeUndefined()
  })

  it("signature help and code lenses come back with dispose, symbols with tags", async () => {
    const { base, dispatch, providerOf } = setup()
    registerSignatureHelpProvider({ ...base, triggerCharacters: ["("], retriggerCharacters: [","] })
    registerCodeLensProvider(base)
    registerDocumentSymbolProvider(base)

    dispatch.mockResolvedValueOnce({ signatures: [{ label: "f(a)" }], activeSignature: 0 })
    const help = (await providerOf("registerSignatureHelpProvider").provideSignatureHelp(
      model,
      at,
      undefined,
      { triggerKind: 2, triggerCharacter: "(", isRetrigger: false }
    )) as { value: { signatures: unknown[] }; dispose: () => void }
    expect(help.value.signatures).toHaveLength(1)
    expect(typeof help.dispose).toBe("function")
    expect(dispatch.mock.calls[0][2]).toMatchObject({
      context: { triggerKind: 2, triggerCharacter: "(", isRetrigger: false },
    })

    dispatch.mockResolvedValueOnce([{ range: wireRange1, command: { command: "c", title: "T" } }])
    expect(await providerOf("registerCodeLensProvider").provideCodeLenses(model)).toMatchObject({
      lenses: [{ range: range1, command: { id: "c", title: "T" } }],
    })

    dispatch.mockResolvedValueOnce([
      { name: "A", kind: 4, range: wireRange1, selectionRange: wireRange1 },
    ])
    expect(
      await providerOf("registerDocumentSymbolProvider").provideDocumentSymbols(model)
    ).toEqual([expect.objectContaining({ name: "A", kind: 4, tags: [] })])
  })

  it("inline completions translate the trigger kind and can be disposed", async () => {
    const { base, dispatch, providerOf } = setup({ items: [{ insertText: "x" }] })
    registerInlineCompletionProvider(base)
    const provider = providerOf("registerInlineCompletionsProvider")
    await provider.provideInlineCompletions(model, at, { triggerKind: 1 })
    await provider.provideInlineCompletions(model, at, { triggerKind: 0 })
    // Monaco Explicit (1) is VS Code Invoke (0); Monaco Automatic (0) is VS Code Automatic (1).
    expect(dispatch.mock.calls.map((call) => (call[2] as { context: unknown }).context)).toEqual([
      { triggerKind: 0 },
      { triggerKind: 1 },
    ])
    expect(typeof provider.disposeInlineCompletions).toBe("function")
  })

  it("colors, folding, selection ranges, links, semantic tokens and inlay hints become Monaco shapes", async () => {
    const { base, dispatch, providerOf } = setup()
    registerColorProvider(base)
    registerFoldingRangeProvider(base)
    registerSelectionRangeProvider(base)
    registerDocumentLinkProvider(base)
    registerDocumentSemanticTokensProvider({
      ...base,
      legend: { tokenTypes: ["a"], tokenModifiers: [] },
    })
    registerDocumentRangeSemanticTokensProvider({
      ...base,
      legend: { tokenTypes: ["a"], tokenModifiers: [] },
    })
    registerInlayHintsProvider(base)
    registerLinkedEditingRangeProvider(base)

    dispatch.mockResolvedValueOnce([
      { label: "red", textEdit: { range: wireRange1, newText: "#f00" } },
    ])
    expect(
      await providerOf("registerColorProvider").provideColorPresentations(model, {
        range: range1,
        color: { red: 1, green: 0, blue: 0, alpha: 1 },
      })
    ).toEqual([{ label: "red", textEdit: { range: range1, text: "#f00" } }])
    expect(dispatch.mock.calls[0][2]).toMatchObject({
      colorInfo: { range: wireRange1, color: { red: 1, green: 0, blue: 0, alpha: 1 } },
    })

    dispatch.mockResolvedValueOnce([{ startLine: 0, endLine: 3, kind: "region" }])
    expect(
      await providerOf("registerFoldingRangeProvider").provideFoldingRanges(model, {})
    ).toEqual([{ start: 1, end: 4, kind: { value: "region" } }])

    dispatch.mockResolvedValueOnce([[{ range: wireRange1, parent: { range: wireRange1 } }]])
    expect(
      await providerOf("registerSelectionRangeProvider").provideSelectionRanges(model, [at])
    ).toEqual([[{ range: range1 }, { range: range1 }]])

    dispatch.mockResolvedValueOnce({ links: [{ range: wireRange1, target: "https://x.dev" }] })
    expect(await providerOf("registerLinkProvider").provideLinks(model)).toEqual({
      links: [{ range: range1, url: { parsed: "https://x.dev" } }],
    })

    dispatch.mockResolvedValueOnce({ data: [0, 1, 2, 0, 0], resultId: "r1" })
    const tokens = (await providerOf(
      "registerDocumentSemanticTokensProvider"
    ).provideDocumentSemanticTokens(model, null)) as { data: Uint32Array; resultId: string }
    expect(tokens.data).toBeInstanceOf(Uint32Array)
    expect(Array.from(tokens.data)).toEqual([0, 1, 2, 0, 0])
    expect(providerOf("registerDocumentSemanticTokensProvider").getLegend()).toEqual({
      tokenTypes: ["a"],
      tokenModifiers: [],
    })

    dispatch.mockResolvedValueOnce({ data: [1] })
    expect(
      await providerOf(
        "registerDocumentRangeSemanticTokensProvider"
      ).provideDocumentRangeSemanticTokens(model, range1)
    ).toMatchObject({ data: Uint32Array.from([1]) })

    dispatch.mockResolvedValueOnce({ hints: [{ position: wireAt, label: ": number", kind: 1 }] })
    const hints = (await providerOf("registerInlayHintsProvider").provideInlayHints(
      model,
      range1
    )) as {
      hints: unknown[]
      dispose: () => void
    }
    expect(hints.hints).toEqual([{ label: ": number", position: at, kind: 1 }])
    expect(typeof hints.dispose).toBe("function")

    dispatch.mockResolvedValueOnce({ ranges: [wireRange1], wordPattern: "[a-z]+" })
    const linked = (await providerOf(
      "registerLinkedEditingRangeProvider"
    ).provideLinkedEditingRanges(model, at)) as { ranges: unknown[]; wordPattern: RegExp }
    expect(linked.ranges).toEqual([range1])
    expect(linked.wordPattern).toEqual(/[a-z]+/)
  })

  it("call and type hierarchy are inert in standalone Monaco, yet unregister cleanly", () => {
    const { base, registered } = setup()
    const call = registerCallHierarchyProvider(base)
    const type = registerTypeHierarchyProvider({ ...base, token: "host-token-2" })
    expect(call).toMatchObject({ token: "host-token", supported: false })
    expect(type.supported).toBe(false)
    expect(registered).toHaveLength(0)
    expect(unregisterByToken("host-token")).toBe(true)
    expect(unregisterByToken("host-token-2")).toBe(true)
  })

  it("passes Monaco's cancellation token on, and skips a call it already cancelled", async () => {
    const { base, dispatch, providerOf } = setup({ contents: ["x"] })
    registerHoverProvider(base)
    const live: MonacoCancellationToken = {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} }),
    }
    await providerOf("registerHoverProvider").provideHover(model, at, live)
    expect(dispatch.mock.calls[0][3]).toBe(live)
    const cancelled = { ...live, isCancellationRequested: true }
    expect(await providerOf("registerHoverProvider").provideHover(model, at, cancelled)).toBeNull()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it("a registration without a host token gets a fresh one", () => {
    const { providerOf } = setup()
    const registration = registerHoverProvider({ extensionId: "lsp", selector: ["go"] })
    expect(registration.token).toEqual(expect.any(String))
    expect(registration.token).not.toBe("host-token")
    expect(providerOf("registerHoverProvider")).toBeDefined()
  })
})

describe("registration tokens", () => {
  it("unregisterByToken disposes the Monaco registration once", () => {
    const { base, registered } = setup()
    const { token } = registerCompletionItemProvider(base)
    expect(unregisterByToken(token)).toBe(true)
    expect(registered[0].dispose).toHaveBeenCalled()
    expect(unregisterByToken(token)).toBe(false)
  })

  it("unregisterByExtension removes every registration of that extension", () => {
    setup()
    registerCompletionItemProvider({ extensionId: "ext.a", selector: ["ts"] })
    registerHoverProvider({ extensionId: "ext.a", selector: ["ts"] })
    registerCompletionItemProvider({ extensionId: "ext.b", selector: ["ts"] })
    expect(unregisterByExtension("ext.a")).toBe(2)
  })

  it("survives a disposable that throws", () => {
    const { base, registered } = setup()
    const { token } = registerCompletionItemProvider(base)
    registered[0].dispose.mockImplementation(() => {
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

describe("workspace symbols", () => {
  it("aggregates every provider and survives one throwing", async () => {
    const { dispatch } = setup()
    registerWorkspaceSymbolProvider({ extensionId: "ext.a", token: "ws-a" })
    registerWorkspaceSymbolProvider({ extensionId: "ext.b", token: "ws-b" })
    dispatch.mockResolvedValueOnce([{ name: "A" }]).mockRejectedValueOnce(new Error("down"))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(await searchWorkspaceSymbols("A")).toEqual([{ name: "A" }])
    } finally {
      warn.mockRestore()
    }
    expect(dispatch).toHaveBeenCalledWith(
      "ext.a",
      "provideWorkspaceSymbols",
      { token: "ws-a", query: "A" },
      undefined
    )
    unregisterByExtension("ext.a")
    unregisterByExtension("ext.b")
    expect(await searchWorkspaceSymbols("A")).toEqual([])
  })
})

describe("diagnostics", () => {
  const marker: MonacoMarker = { severity: "error", message: "boom", range: range1 }

  it("keeps diagnostics for an unopened file and applies them when it opens", () => {
    const { setModelMarkers } = setup()
    setDiagnostics({ extensionId: "ext.eslint", uri: "file:///x.ts", markers: [marker] })
    expect(setModelMarkers).toHaveBeenCalledWith("file:///x.ts", "ext.eslint", [marker])
    expect(getDiagnostics("file:///x.ts")).toEqual([{ owner: "ext.eslint", markers: [marker] }])
    setModelMarkers.mockClear()
    notifyEditorMounted(makeFakeEditor("e1", "file:///x.ts"))
    expect(setModelMarkers).toHaveBeenCalledWith("file:///x.ts", "ext.eslint", [marker])
  })

  it("an empty set clears them, and an extension's cleanup clears its own", () => {
    const { setModelMarkers } = setup()
    setDiagnostics({ extensionId: "ext.a", uri: "file:///x.ts", markers: [marker] })
    setDiagnostics({ extensionId: "ext.b", uri: "file:///x.ts", markers: [marker] })
    setDiagnostics({ extensionId: "ext.b", uri: "file:///x.ts", markers: [] })
    expect(getDiagnostics("file:///x.ts").map((entry) => entry.owner)).toEqual(["ext.a"])
    unregisterByExtension("ext.a")
    expect(getDiagnostics("file:///x.ts")).toEqual([])
    expect(setModelMarkers).toHaveBeenLastCalledWith("file:///x.ts", "ext.a", [])
  })
})

describe("decorations", () => {
  it("registers a type and forwards decorations to the editor", () => {
    setup()
    const editor = makeFakeEditor("e1", "file:///x.ts")
    notifyEditorMounted(editor)
    const { typeId } = registerDecorationType({
      extensionId: "ext.gitlens",
      options: { className: "blame-line" },
    })
    setDecorations({
      editorId: "e1",
      typeId,
      decorations: [{ range: range1, options: { isWholeLine: true } }],
    })
    expect(editor.setDecorations).toHaveBeenCalledWith(typeId, expect.any(Array))
    expect(() => setDecorations({ editorId: "nope", typeId, decorations: [] })).not.toThrow()
  })
})

describe("language configuration and language changes", () => {
  it("revives RegExps that crossed JSON", () => {
    expect(
      reviveRegExps({
        wordPattern: { $regexp: "\\w+", flags: "g" },
        onEnterRules: [{ beforeText: { $regexp: "^\\s*//" } }],
        comments: { lineComment: "//" },
      })
    ).toEqual({
      wordPattern: /\w+/g,
      onEnterRules: [{ beforeText: /^\s*\/\// }],
      comments: { lineComment: "//" },
    })
  })

  it("applies a configuration, replaces it under the same handle, and disposes it", () => {
    const { languageConfigurations } = setup()
    setLanguageConfiguration({
      extensionId: "ext.a",
      handle: "h1",
      language: "go",
      configuration: { wordPattern: { $regexp: "[a-z]+" } },
    })
    expect(languageConfigurations[0]).toMatchObject({
      languageId: "go",
      configuration: { wordPattern: /[a-z]+/ },
    })
    setLanguageConfiguration({
      extensionId: "ext.a",
      handle: "h1",
      language: "go",
      configuration: {},
    })
    expect(languageConfigurations[0].dispose).toHaveBeenCalled()
    expect(disposeLanguageConfiguration("h1")).toBe(true)
    expect(languageConfigurations[1].dispose).toHaveBeenCalled()
    expect(disposeLanguageConfiguration("h1")).toBe(false)

    setLanguageConfiguration({
      extensionId: "ext.a",
      handle: "h2",
      language: "go",
      configuration: {},
    })
    unregisterByExtension("ext.a")
    expect(languageConfigurations[2].dispose).toHaveBeenCalled()
  })

  it("switching a document's language tells the editors showing it", async () => {
    const { setModelLanguage } = setup(null, ["file:///x.ts"])
    notifyEditorMounted(makeFakeEditor("e1", "file:///x.ts"))
    await new Promise((r) => setTimeout(r, 0))
    const events: string[] = []
    const dispose = onEditorChange((e) => events.push(`${e.kind}:${e.editorId}`))
    expect(setDocumentLanguage("file:///x.ts", "javascript")).toBe(true)
    expect(setDocumentLanguage("file:///closed.ts", "javascript")).toBe(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(setModelLanguage).toHaveBeenCalledWith("file:///x.ts", "javascript")
    expect(events).toEqual(["change-language:e1"])
    dispose()
  })
})
