import { readFileSync } from "node:fs"
import path from "node:path"

import {
  handleDisposeLanguageConfiguration,
  handleExtensionCleanup,
  handleLanguagesRegister,
  handleLanguagesSetDiagnostics,
  handleLanguagesUnregister,
  handleSetLanguageConfiguration,
  handleSetTextDocumentLanguage,
  handleWindowActiveTextEditorGet,
  listSupportedLanguagesKinds,
} from "./languages-handler"

jest.mock("./monaco-bridge", () => {
  const tokenByCall: string[] = []
  const make = (suffix: string) =>
    jest.fn(() => {
      const tok = `tok-${suffix}-${tokenByCall.length}`
      tokenByCall.push(tok)
      return { token: tok, supported: suffix !== "callHierarchy", dispose: jest.fn() }
    })
  return {
    registerCompletionItemProvider: make("completion"),
    registerHoverProvider: make("hover"),
    registerDefinitionProvider: make("definition"),
    registerDeclarationProvider: make("declaration"),
    registerTypeDefinitionProvider: make("typeDefinition"),
    registerImplementationProvider: make("implementation"),
    registerDocumentHighlightProvider: make("documentHighlight"),
    registerReferenceProvider: make("references"),
    registerDocumentFormattingProvider: make("docFormat"),
    registerDocumentRangeFormattingProvider: make("rangeFormat"),
    registerCodeLensProvider: make("codeLens"),
    registerCodeActionsProvider: make("codeActions"),
    registerRenameProvider: make("rename"),
    registerDocumentSymbolProvider: make("docSymbol"),
    registerInlineCompletionProvider: make("inlineCompletion"),
    registerSignatureHelpProvider: make("signatureHelp"),
    registerWorkspaceSymbolProvider: make("workspaceSymbol"),
    registerColorProvider: make("color"),
    registerFoldingRangeProvider: make("foldingRange"),
    registerSelectionRangeProvider: make("selectionRange"),
    registerDocumentLinkProvider: make("documentLink"),
    registerOnTypeFormattingProvider: make("onTypeFormatting"),
    registerDocumentSemanticTokensProvider: make("semanticTokens"),
    registerDocumentRangeSemanticTokensProvider: make("rangeSemanticTokens"),
    registerInlayHintsProvider: make("inlayHints"),
    registerCallHierarchyProvider: make("callHierarchy"),
    registerTypeHierarchyProvider: make("typeHierarchy"),
    registerLinkedEditingRangeProvider: make("linkedEditing"),
    setDiagnostics: jest.fn(),
    setLanguageConfiguration: jest.fn(),
    disposeLanguageConfiguration: jest.fn(() => true),
    setDocumentLanguage: jest.fn(() => true),
    unregisterByExtension: jest.fn(() => 3),
    unregisterByToken: jest.fn(() => true),
    getActiveEditorSnapshot: jest.fn(() => ({
      editorId: "ed-1",
      uri: "canvas:///s/d.ts",
      language: "typescript",
      selection: null,
      position: null,
    })),
  }
})

const bridge = jest.requireMock("./monaco-bridge") as Record<string, jest.Mock>

beforeEach(() => {
  for (const fn of Object.values(bridge)) {
    if (typeof fn?.mockClear === "function") fn.mockClear()
  }
})

describe("languages-handler", () => {
  it("lists exactly the provider kinds the extension host registers", () => {
    // Every `registerProvider("<kind>"` and `registerLocationProvider("<kind>"`
    // in the sidecar's `vscode.languages` must have a bridge entry, and the
    // bridge must not list kinds nothing sends.
    const source = readFileSync(
      path.join(process.cwd(), "sidecar/vscode-ext-host/src/vscode-shim/languages.ts"),
      "utf8"
    )
    const sent = new Set(
      [...source.matchAll(/register(?:Location)?Provider\(\s*"([A-Za-z]+)"/g)].map(
        (match) => match[1]
      )
    )
    expect(sent.size).toBeGreaterThan(20)
    expect(listSupportedLanguagesKinds()).toEqual([...sent].sort())
  })

  it("reports when the editor has no such feature", () => {
    expect(
      handleLanguagesRegister({ kind: "callHierarchy", extensionId: "ext", selector: ["ts"] })
    ).toMatchObject({ supported: false })
    expect(
      handleLanguagesRegister({ kind: "declaration", extensionId: "ext", selector: ["ts"] })
    ).toMatchObject({ supported: true })
  })

  it("routes language configuration and language switches to the bridge", () => {
    const configuration = { handle: "h", extensionId: "ext", language: "go", configuration: {} }
    expect(handleSetLanguageConfiguration(configuration)).toBeNull()
    expect(bridge.setLanguageConfiguration).toHaveBeenCalledWith(configuration)
    expect(handleDisposeLanguageConfiguration({ handle: "h" })).toEqual({ removed: true })
    expect(handleSetTextDocumentLanguage({ uri: "file:///a.go", languageId: "go" })).toEqual({
      changed: true,
    })
    expect(bridge.setDocumentLanguage).toHaveBeenCalledWith("file:///a.go", "go")
  })

  it("routes completionItem registration to the bridge", () => {
    const result = handleLanguagesRegister({
      kind: "completionItem",
      extensionId: "ext-1",
      selector: ["typescript"],
      triggerCharacters: ["."],
    })
    expect(bridge.registerCompletionItemProvider).toHaveBeenCalledWith(
      expect.objectContaining({ extensionId: "ext-1", selector: ["typescript"] })
    )
    expect(result.token).toMatch(/^tok-completion-/)
  })

  it("routes hover registration to the bridge", () => {
    handleLanguagesRegister({ kind: "hover", extensionId: "ext-2", selector: ["python"] })
    expect(bridge.registerHoverProvider).toHaveBeenCalledTimes(1)
  })

  it("routes inlayHints registration to the bridge", () => {
    handleLanguagesRegister({ kind: "inlayHints", extensionId: "ext-3", selector: ["rust"] })
    expect(bridge.registerInlayHintsProvider).toHaveBeenCalledTimes(1)
  })

  it("routes documentSemanticTokens registration to the bridge", () => {
    handleLanguagesRegister({
      kind: "documentSemanticTokens",
      extensionId: "ext-4",
      selector: ["rust"],
      legend: { tokenTypes: ["keyword"], tokenModifiers: [] },
    })
    expect(bridge.registerDocumentSemanticTokensProvider).toHaveBeenCalledTimes(1)
  })

  it("throws on unknown kinds", () => {
    expect(() =>
      handleLanguagesRegister({ kind: "imagined", extensionId: "ext-99", selector: ["x"] })
    ).toThrow(/unknown provider kind: imagined/)
  })

  it("forwards unregister to the bridge", () => {
    const res = handleLanguagesUnregister({ token: "tok-abc" })
    expect(bridge.unregisterByToken).toHaveBeenCalledWith("tok-abc")
    expect(res.removed).toBe(true)
  })

  it("forwards setDiagnostics with the marker payload", () => {
    const markers = [{ severity: "error", message: "x", range: {} }]
    handleLanguagesSetDiagnostics({
      extensionId: "ext-1",
      uri: "canvas:///s/d.ts",
      markers,
    })
    expect(bridge.setDiagnostics).toHaveBeenCalledWith({
      extensionId: "ext-1",
      uri: "canvas:///s/d.ts",
      markers,
    })
  })

  it("extension cleanup forwards removed count", () => {
    const result = handleExtensionCleanup({ extensionId: "ext-1" })
    expect(bridge.unregisterByExtension).toHaveBeenCalledWith("ext-1")
    expect(result.removed).toBe(3)
  })

  it("window:activeTextEditor:get returns the bridge snapshot", () => {
    const snapshot = handleWindowActiveTextEditorGet()
    expect(bridge.getActiveEditorSnapshot).toHaveBeenCalled()
    expect(snapshot).toEqual({
      editorId: "ed-1",
      uri: "canvas:///s/d.ts",
      language: "typescript",
      selection: null,
      position: null,
    })
  })
})
