const mockRegistrations = new Map<string, unknown>()
let mockProviderRoute:
  ((extensionId: string, method: string, payload: unknown) => Promise<unknown>) | undefined

function mockRegister(name: string) {
  return (request: unknown) => {
    mockRegistrations.set(name, request)
    return { dispose: jest.fn() }
  }
}

jest.mock("@/lib/plugin/vscode-shim/monaco-bridge", () => ({
  registerCallHierarchyProvider: mockRegister("callHierarchy"),
  registerCodeActionsProvider: mockRegister("codeActions"),
  registerCodeLensProvider: mockRegister("codeLens"),
  registerColorProvider: mockRegister("color"),
  registerCompletionItemProvider: mockRegister("completion"),
  registerDefinitionProvider: mockRegister("definition"),
  registerDocumentFormattingProvider: mockRegister("formatting"),
  registerDocumentLinkProvider: mockRegister("links"),
  registerDocumentRangeFormattingProvider: mockRegister("rangeFormatting"),
  registerDocumentRangeSemanticTokensProvider: mockRegister("rangeSemanticTokens"),
  registerDocumentSemanticTokensProvider: mockRegister("semanticTokens"),
  registerDocumentSymbolProvider: mockRegister("symbols"),
  registerFoldingRangeProvider: mockRegister("folding"),
  registerHoverProvider: mockRegister("hover"),
  registerInlayHintsProvider: mockRegister("inlay"),
  registerInlineCompletionProvider: mockRegister("inlineCompletion"),
  registerLinkedEditingRangeProvider: mockRegister("linkedEditing"),
  registerOnTypeFormattingProvider: mockRegister("onTypeFormatting"),
  registerReferenceProvider: mockRegister("references"),
  registerRenameProvider: mockRegister("rename"),
  registerSelectionRangeProvider: mockRegister("selection"),
  registerSignatureHelpProvider: mockRegister("signature"),
  registerTypeHierarchyProvider: mockRegister("typeHierarchy"),
  registerWorkspaceSymbolProvider: mockRegister("workspaceSymbols"),
  registerProviderDispatchRoute: (
    _extensionId: string,
    route: (extensionId: string, method: string, payload: unknown) => Promise<unknown>
  ) => {
    mockProviderRoute = route
    return jest.fn()
  },
  unregisterByExtension: jest.fn(),
}))

jest.mock("@/lib/plugin/vscode-shim/lsp-workspace-manager", () => ({
  resolveMaterializedDocumentUri: (uri: string) =>
    uri === "skill:///s/scripts/a.ts" ? "file:///tmp/s/scripts/a.ts" : null,
  resolveMonacoDocumentUri: (uri: string) =>
    uri === "file:///tmp/s/scripts/b.ts" ? "skill:///s/scripts/b.ts" : uri,
}))

import { registerLspMonacoProviders } from "./lsp-monaco-runtime"
import type { LspClientAdapter, LspServerRecord } from "./lsp-registry"

function record(capabilities: Record<string, unknown>): LspServerRecord {
  return {
    ownerId: "user",
    serverId: "ts",
    key: "user:ts",
    config: {
      id: "ts",
      name: "TypeScript",
      command: "typescript-language-server",
      languages: ["typescript"],
    },
    pluginPath: "/tmp",
    state: "running",
    registrationOrder: 0,
    capabilities,
  }
}

beforeEach(() => {
  mockRegistrations.clear()
  mockProviderRoute = undefined
})

it("registers only capabilities declared by initialize", () => {
  const client: LspClientAdapter = { start: jest.fn(), stop: jest.fn() }
  registerLspMonacoProviders({
    record: record({
      completionProvider: { triggerCharacters: ["."] },
      definitionProvider: true,
      semanticTokensProvider: {
        legend: { tokenTypes: ["type"], tokenModifiers: [] },
        range: true,
      },
    }),
    client,
  })

  expect([...mockRegistrations.keys()].sort()).toEqual([
    "completion",
    "definition",
    "rangeSemanticTokens",
  ])
  expect(mockRegistrations.get("completion")).toMatchObject({
    selector: ["typescript"],
    triggerCharacters: ["."],
  })
})

it("does not register semantic token modes the server did not declare", () => {
  const client: LspClientAdapter = { start: jest.fn(), stop: jest.fn() }
  registerLspMonacoProviders({
    record: record({
      semanticTokensProvider: {
        legend: { tokenTypes: ["type"], tokenModifiers: [] },
        full: { delta: true },
        range: false,
      },
    }),
    client,
  })

  expect(mockRegistrations.has("semanticTokens")).toBe(true)
  expect(mockRegistrations.has("rangeSemanticTokens")).toBe(false)
})

it("maps Monaco URIs to materialized file URIs and maps locations back", async () => {
  const request = jest.fn(async () => [
    {
      uri: "file:///tmp/s/scripts/b.ts",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
    },
  ])
  const client: LspClientAdapter = { start: jest.fn(), stop: jest.fn(), request }
  registerLspMonacoProviders({
    record: record({ definitionProvider: true }),
    client,
  })

  const result = await mockProviderRoute?.("user:ts", "provideDefinition", {
    uri: "skill:///s/scripts/a.ts",
    position: { line: 2, character: 4 },
  })

  expect(request).toHaveBeenCalledWith({
    ownerId: "user",
    serverId: "ts",
    method: "textDocument/definition",
    payload: {
      textDocument: { uri: "file:///tmp/s/scripts/a.ts" },
      position: { line: 2, character: 4 },
    },
  })
  expect(result).toMatchObject([{ uri: "skill:///s/scripts/b.ts" }])
})
