/**
 * `vscode.languages` — provider registration (Monaco-backed).
 *
 * Every register* call routes to the renderer's `monaco-bridge.ts`. The
 * sidecar holds the provider function and is invoked via the
 * `extension:call` RPC when Monaco needs a result.
 */

import { Disposable } from "./types"
import type { ShimDependencies } from "./index"

interface DocumentSelector {
  language?: string
  scheme?: string
  pattern?: string
}

function normalizeSelector(
  selector: string | DocumentSelector | Array<string | DocumentSelector>
): string[] {
  const arr = Array.isArray(selector) ? selector : [selector]
  const out: string[] = []
  for (const item of arr) {
    if (typeof item === "string") out.push(item)
    else if (item.language) out.push(item.language)
  }
  return out.length > 0 ? out : ["*"]
}

export function createLanguagesNamespace(deps: ShimDependencies) {
  const { connection, extensionId, registerProviderCallback } = deps
  const diagnosticCollections = new Map<string, Map<string, unknown[]>>()

  function registerProvider(
    kind: string,
    selector: string | DocumentSelector | Array<string | DocumentSelector>,
    invocation: (payload: unknown) => Promise<unknown> | unknown,
    extra?: Record<string, unknown>
  ): Disposable {
    const langs = normalizeSelector(selector)
    const token = `prov:${extensionId}:${kind}:${Math.random().toString(36).slice(2, 10)}`
    const unsubscribe = registerProviderCallback(token, invocation)
    void connection.sendRequest("languages:register", {
      extensionId,
      kind,
      token,
      selector: langs,
      ...extra,
    })
    return new Disposable(() => {
      unsubscribe()
      void connection.sendNotification("languages:unregister", { token })
    })
  }

  return {
    registerCompletionItemProvider(
      selector: string | DocumentSelector | Array<string | DocumentSelector>,
      provider: { provideCompletionItems: (...args: unknown[]) => unknown },
      ...triggerCharacters: string[]
    ) {
      return registerProvider(
        "completionItem",
        selector,
        (payload) => provider.provideCompletionItems(payload),
        { triggerCharacters }
      )
    },
    registerHoverProvider(
      selector: string | DocumentSelector,
      provider: { provideHover: (...args: unknown[]) => unknown }
    ) {
      return registerProvider("hover", selector, (payload) => provider.provideHover(payload))
    },
    registerDefinitionProvider(
      selector: string | DocumentSelector,
      provider: { provideDefinition: (...args: unknown[]) => unknown }
    ) {
      return registerProvider("definition", selector, (payload) =>
        provider.provideDefinition(payload)
      )
    },
    registerReferenceProvider(
      selector: string | DocumentSelector,
      provider: { provideReferences: (...args: unknown[]) => unknown }
    ) {
      return registerProvider("references", selector, (payload) =>
        provider.provideReferences(payload)
      )
    },
    registerDocumentFormattingEditProvider(
      selector: string | DocumentSelector,
      provider: { provideDocumentFormattingEdits: (...args: unknown[]) => unknown }
    ) {
      return registerProvider("documentFormatting", selector, (payload) =>
        provider.provideDocumentFormattingEdits(payload)
      )
    },
    registerDocumentRangeFormattingEditProvider(
      selector: string | DocumentSelector,
      provider: { provideDocumentRangeFormattingEdits: (...args: unknown[]) => unknown }
    ) {
      return registerProvider("documentRangeFormatting", selector, (payload) =>
        provider.provideDocumentRangeFormattingEdits(payload)
      )
    },
    registerOnTypeFormattingEditProvider(
      selector: string | DocumentSelector,
      provider: { provideOnTypeFormattingEdits: (...args: unknown[]) => unknown },
      firstChar: string,
      ...moreCharacters: string[]
    ) {
      return registerProvider(
        "onTypeFormatting",
        selector,
        (payload) => provider.provideOnTypeFormattingEdits(payload),
        { firstChar, moreCharacters }
      )
    },
    registerSignatureHelpProvider(
      selector: string | DocumentSelector,
      provider: { provideSignatureHelp: (...args: unknown[]) => unknown }
    ) {
      return registerProvider("signatureHelp", selector, (payload) =>
        provider.provideSignatureHelp(payload)
      )
    },
    registerCodeActionsProvider(
      selector: string | DocumentSelector,
      provider: { provideCodeActions: (...args: unknown[]) => unknown }
    ) {
      return registerProvider("codeActions", selector, (payload) =>
        provider.provideCodeActions(payload)
      )
    },
    registerCodeLensProvider(
      selector: string | DocumentSelector,
      provider: { provideCodeLenses: (...args: unknown[]) => unknown }
    ) {
      return registerProvider("codeLens", selector, (payload) =>
        provider.provideCodeLenses(payload)
      )
    },
    registerInlineCompletionItemProvider(
      selector: string | DocumentSelector,
      provider: { provideInlineCompletionItems: (...args: unknown[]) => unknown }
    ) {
      return registerProvider("inlineCompletion", selector, (payload) =>
        provider.provideInlineCompletionItems(payload)
      )
    },
    registerDocumentSymbolProvider(
      selector: string | DocumentSelector,
      provider: { provideDocumentSymbols: (...args: unknown[]) => unknown }
    ) {
      return registerProvider("documentSymbol", selector, (payload) =>
        provider.provideDocumentSymbols(payload)
      )
    },
    registerWorkspaceSymbolProvider(provider: {
      provideWorkspaceSymbols: (...args: unknown[]) => unknown
    }) {
      return registerProvider("workspaceSymbol", "*", (payload) =>
        provider.provideWorkspaceSymbols(payload)
      )
    },
    registerRenameProvider(
      selector: string | DocumentSelector,
      provider: { provideRenameEdits: (...args: unknown[]) => unknown }
    ) {
      return registerProvider("rename", selector, (payload) => provider.provideRenameEdits(payload))
    },
    registerDocumentSemanticTokensProvider(
      selector: string | DocumentSelector,
      provider: { provideDocumentSemanticTokens: (...args: unknown[]) => unknown },
      legend: unknown
    ) {
      return registerProvider(
        "semanticTokens",
        selector,
        (payload) => provider.provideDocumentSemanticTokens(payload),
        { legend }
      )
    },
    registerDocumentRangeSemanticTokensProvider(
      selector: string | DocumentSelector,
      provider: { provideDocumentRangeSemanticTokens: (...args: unknown[]) => unknown },
      legend: unknown
    ) {
      return registerProvider(
        "rangeSemanticTokens",
        selector,
        (payload) => provider.provideDocumentRangeSemanticTokens(payload),
        { legend }
      )
    },
    registerColorProvider(
      selector: string | DocumentSelector,
      provider: { provideDocumentColors: (...args: unknown[]) => unknown }
    ) {
      return registerProvider("documentColor", selector, (payload) =>
        provider.provideDocumentColors(payload)
      )
    },
    registerFoldingRangeProvider(
      selector: string | DocumentSelector,
      provider: { provideFoldingRanges: (...args: unknown[]) => unknown }
    ) {
      return registerProvider("foldingRange", selector, (payload) =>
        provider.provideFoldingRanges(payload)
      )
    },
    registerSelectionRangeProvider(
      selector: string | DocumentSelector,
      provider: { provideSelectionRanges: (...args: unknown[]) => unknown }
    ) {
      return registerProvider("selectionRange", selector, (payload) =>
        provider.provideSelectionRanges(payload)
      )
    },
    registerDocumentLinkProvider(
      selector: string | DocumentSelector,
      provider: { provideDocumentLinks: (...args: unknown[]) => unknown }
    ) {
      return registerProvider("documentLink", selector, (payload) =>
        provider.provideDocumentLinks(payload)
      )
    },
    createDiagnosticCollection(name?: string) {
      const collectionName = name ?? `${extensionId}-default`
      const byUri = new Map<string, unknown[]>()
      diagnosticCollections.set(collectionName, byUri)
      const collection = {
        name: collectionName,
        set(uri: unknown, diagnostics: unknown[] | undefined) {
          const key = String(uri)
          if (!diagnostics || diagnostics.length === 0) {
            byUri.delete(key)
            void connection.sendNotification("languages:clearDiagnostics", {
              extensionId,
              collectionName,
              uri,
            })
          } else {
            byUri.set(key, diagnostics)
            void connection.sendNotification("languages:setDiagnostics", {
              extensionId,
              collectionName,
              uri,
              diagnostics,
            })
          }
        },
        delete(uri: unknown) {
          collection.set(uri, [])
        },
        clear() {
          for (const uri of byUri.keys()) {
            collection.delete(uri)
          }
        },
        forEach(callback: (uri: unknown, diagnostics: unknown[]) => void) {
          for (const [key, diags] of byUri) {
            callback(key, diags)
          }
        },
        get(uri: unknown): unknown[] | undefined {
          return byUri.get(String(uri))
        },
        has(uri: unknown): boolean {
          return byUri.has(String(uri))
        },
        dispose() {
          collection.clear()
          diagnosticCollections.delete(collectionName)
        },
      }
      return collection
    },
    setTextDocumentLanguage(document: unknown, languageId: string) {
      return connection.sendRequest("languages:setTextDocumentLanguage", {
        extensionId,
        document,
        languageId,
      })
    },
    getLanguages() {
      return connection.sendRequest<string[]>("languages:list", {})
    },
  }
}
