import {
  registerCallHierarchyProvider,
  registerCodeActionsProvider,
  registerCodeLensProvider,
  registerColorProvider,
  registerCompletionItemProvider,
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
  registerProviderDispatchRoute,
  registerReferenceProvider,
  registerRenameProvider,
  registerSelectionRangeProvider,
  registerSignatureHelpProvider,
  registerTypeHierarchyProvider,
  registerWorkspaceSymbolProvider,
  unregisterByExtension,
  type Disposable,
} from "@/lib/plugin/vscode-shim/monaco-bridge"
import {
  resolveMaterializedDocumentUri,
  resolveMonacoDocumentUri,
} from "@/lib/plugin/vscode-shim/lsp-workspace-manager"
import type { LspClientAdapter, LspServerRecord } from "./lsp-registry"

type CapabilityMap = Record<string, unknown>
type ProviderPayload = Record<string, unknown>

function capabilityObject(
  capabilities: CapabilityMap,
  name: string
): Record<string, unknown> | null {
  const value = capabilities[name]
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function hasCapability(capabilities: CapabilityMap, name: string): boolean {
  const value = capabilities[name]
  return value === true || (typeof value === "object" && value !== null)
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined
}

function remapUris(value: unknown, map: (uri: string) => string): unknown {
  if (Array.isArray(value)) return value.map((entry) => remapUris(entry, map))
  if (!value || typeof value !== "object") return value
  const input = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(input)) {
    if ((key === "uri" || key === "targetUri") && typeof entry === "string") {
      out[key] = map(entry)
    } else if (key === "changes" && entry && typeof entry === "object" && !Array.isArray(entry)) {
      out[key] = Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(([uri, edits]) => [
          map(uri),
          remapUris(edits, map),
        ])
      )
    } else {
      out[key] = remapUris(entry, map)
    }
  }
  return out
}

function materializedUri(monacoUri: unknown): string {
  if (typeof monacoUri !== "string") throw new Error("LSP provider request is missing a URI")
  return resolveMaterializedDocumentUri(monacoUri) ?? monacoUri
}

function documentParams(payload: ProviderPayload): ProviderPayload {
  const { token: _token, uri, ...rest } = payload
  return {
    textDocument: { uri: materializedUri(uri) },
    ...(remapUris(
      rest,
      (value) => resolveMaterializedDocumentUri(value) ?? value
    ) as ProviderPayload),
  }
}

function requestDescriptor(
  bridgeMethod: string,
  payload: ProviderPayload
): { method: string; payload: unknown } | null {
  switch (bridgeMethod) {
    case "provideCompletionItems":
      return { method: "textDocument/completion", payload: documentParams(payload) }
    case "provideHover":
      return { method: "textDocument/hover", payload: documentParams(payload) }
    case "provideDefinition":
      return { method: "textDocument/definition", payload: documentParams(payload) }
    case "provideReferences":
      return {
        method: "textDocument/references",
        payload: { ...documentParams(payload), context: { includeDeclaration: true } },
      }
    case "provideDocumentFormattingEdits":
      return {
        method: "textDocument/formatting",
        payload: { ...documentParams(payload), options: { tabSize: 2, insertSpaces: true } },
      }
    case "provideDocumentRangeFormattingEdits":
      return {
        method: "textDocument/rangeFormatting",
        payload: { ...documentParams(payload), options: { tabSize: 2, insertSpaces: true } },
      }
    case "provideCodeLenses":
      return { method: "textDocument/codeLens", payload: documentParams(payload) }
    case "provideCodeActions":
      return {
        method: "textDocument/codeAction",
        payload: { ...documentParams(payload), context: { diagnostics: [] } },
      }
    case "provideRenameEdits":
      return { method: "textDocument/rename", payload: documentParams(payload) }
    case "provideDocumentSymbols":
      return { method: "textDocument/documentSymbol", payload: documentParams(payload) }
    case "provideInlineCompletionItems":
      return { method: "textDocument/inlineCompletion", payload: documentParams(payload) }
    case "provideSignatureHelp":
      return { method: "textDocument/signatureHelp", payload: documentParams(payload) }
    case "provideWorkspaceSymbols": {
      const { token: _token, ...rest } = payload
      return { method: "workspace/symbol", payload: rest }
    }
    case "provideDocumentColors":
      return { method: "textDocument/documentColor", payload: documentParams(payload) }
    case "provideColorPresentations": {
      const params = documentParams(payload)
      const info = params.colorInfo as { color?: unknown; range?: unknown } | undefined
      delete params.colorInfo
      return {
        method: "textDocument/colorPresentation",
        payload: { ...params, color: info?.color, range: info?.range },
      }
    }
    case "provideFoldingRanges":
      return { method: "textDocument/foldingRange", payload: documentParams(payload) }
    case "provideDocumentLinks":
      return { method: "textDocument/documentLink", payload: documentParams(payload) }
    case "provideOnTypeFormattingEdits":
      return {
        method: "textDocument/onTypeFormatting",
        payload: {
          ...documentParams(payload),
          ch: payload.ch,
          options: { tabSize: 2, insertSpaces: true },
        },
      }
    case "provideDocumentSemanticTokens":
      return { method: "textDocument/semanticTokens/full", payload: documentParams(payload) }
    case "provideDocumentRangeSemanticTokens":
      return { method: "textDocument/semanticTokens/range", payload: documentParams(payload) }
    case "provideInlayHints":
      return { method: "textDocument/inlayHint", payload: documentParams(payload) }
    case "prepareCallHierarchy":
      return { method: "textDocument/prepareCallHierarchy", payload: documentParams(payload) }
    case "provideIncomingCalls":
      return {
        method: "callHierarchy/incomingCalls",
        payload: remapUris(
          { item: payload.item },
          (uri) => resolveMaterializedDocumentUri(uri) ?? uri
        ),
      }
    case "provideOutgoingCalls":
      return {
        method: "callHierarchy/outgoingCalls",
        payload: remapUris(
          { item: payload.item },
          (uri) => resolveMaterializedDocumentUri(uri) ?? uri
        ),
      }
    case "prepareTypeHierarchy":
      return { method: "textDocument/prepareTypeHierarchy", payload: documentParams(payload) }
    case "provideSupertypes":
      return {
        method: "typeHierarchy/supertypes",
        payload: remapUris(
          { item: payload.item },
          (uri) => resolveMaterializedDocumentUri(uri) ?? uri
        ),
      }
    case "provideSubtypes":
      return {
        method: "typeHierarchy/subtypes",
        payload: remapUris(
          { item: payload.item },
          (uri) => resolveMaterializedDocumentUri(uri) ?? uri
        ),
      }
    case "provideLinkedEditingRanges":
      return { method: "textDocument/linkedEditingRange", payload: documentParams(payload) }
    default:
      return null
  }
}

async function dispatchProviderRequest(
  client: LspClientAdapter,
  record: LspServerRecord,
  bridgeMethod: string,
  rawPayload: unknown
): Promise<unknown> {
  const payload = (rawPayload ?? {}) as ProviderPayload
  if (bridgeMethod === "provideSelectionRanges") {
    const positions = Array.isArray(payload.positions) ? payload.positions : []
    const values = await Promise.all(
      positions.map((position) =>
        client.request?.({
          ownerId: record.ownerId,
          serverId: record.serverId,
          method: "textDocument/selectionRange",
          payload: {
            textDocument: { uri: materializedUri(payload.uri) },
            positions: [position],
          },
        })
      )
    )
    return values.map((value) => {
      const mapped = remapUris(value, resolveMonacoDocumentUri)
      return Array.isArray(mapped) ? mapped : []
    })
  }
  const descriptor = requestDescriptor(bridgeMethod, payload)
  if (!descriptor || !client.request) return null
  const result = await client.request({
    ownerId: record.ownerId,
    serverId: record.serverId,
    method: descriptor.method,
    payload: descriptor.payload,
  })
  const mapped = remapUris(result, resolveMonacoDocumentUri)
  if (bridgeMethod === "provideDocumentLinks") {
    return { links: Array.isArray(mapped) ? mapped : [] }
  }
  if (bridgeMethod === "provideInlayHints") {
    return { hints: Array.isArray(mapped) ? mapped : [] }
  }
  return mapped
}

/** Register only providers explicitly declared by an initialized LSP server. */
export function registerLspMonacoProviders(input: {
  record: LspServerRecord
  client: LspClientAdapter
  languages?: string[]
}): Disposable {
  const { record, client } = input
  const capabilities = (record.capabilities ?? {}) as CapabilityMap
  const selector = input.languages ?? record.config.languages
  const extensionId = record.key
  const disposables: Disposable[] = []
  const add = (value: Disposable) => disposables.push(value)

  const removeRoute = registerProviderDispatchRoute(
    extensionId,
    async <T>(_id: string, method: string, payload: unknown): Promise<T> =>
      (await dispatchProviderRequest(client, record, method, payload)) as T
  )

  const completion = capabilityObject(capabilities, "completionProvider")
  if (hasCapability(capabilities, "completionProvider")) {
    add(
      registerCompletionItemProvider({
        extensionId,
        selector,
        triggerCharacters: stringArray(completion?.triggerCharacters),
      })
    )
  }
  if (hasCapability(capabilities, "hoverProvider"))
    add(registerHoverProvider({ extensionId, selector }))
  if (hasCapability(capabilities, "definitionProvider"))
    add(registerDefinitionProvider({ extensionId, selector }))
  if (hasCapability(capabilities, "referencesProvider"))
    add(registerReferenceProvider({ extensionId, selector }))
  if (hasCapability(capabilities, "documentFormattingProvider"))
    add(registerDocumentFormattingProvider({ extensionId, selector }))
  if (hasCapability(capabilities, "documentRangeFormattingProvider"))
    add(registerDocumentRangeFormattingProvider({ extensionId, selector }))
  if (hasCapability(capabilities, "codeLensProvider"))
    add(registerCodeLensProvider({ extensionId, selector }))
  if (hasCapability(capabilities, "codeActionProvider"))
    add(registerCodeActionsProvider({ extensionId, selector }))
  if (hasCapability(capabilities, "renameProvider"))
    add(registerRenameProvider({ extensionId, selector }))
  if (hasCapability(capabilities, "documentSymbolProvider"))
    add(registerDocumentSymbolProvider({ extensionId, selector }))
  if (hasCapability(capabilities, "inlineCompletionProvider"))
    add(registerInlineCompletionProvider({ extensionId, selector }))

  const signature = capabilityObject(capabilities, "signatureHelpProvider")
  if (signature) {
    add(
      registerSignatureHelpProvider({
        extensionId,
        selector,
        triggerCharacters: stringArray(signature.triggerCharacters),
        retriggerCharacters: stringArray(signature.retriggerCharacters),
      })
    )
  }
  if (hasCapability(capabilities, "workspaceSymbolProvider"))
    add(registerWorkspaceSymbolProvider({ extensionId }))
  if (hasCapability(capabilities, "colorProvider"))
    add(registerColorProvider({ extensionId, selector }))
  if (hasCapability(capabilities, "foldingRangeProvider"))
    add(registerFoldingRangeProvider({ extensionId, selector }))
  if (hasCapability(capabilities, "selectionRangeProvider"))
    add(registerSelectionRangeProvider({ extensionId, selector }))
  if (hasCapability(capabilities, "documentLinkProvider"))
    add(registerDocumentLinkProvider({ extensionId, selector }))

  const onType = capabilityObject(capabilities, "documentOnTypeFormattingProvider")
  if (onType && typeof onType.firstTriggerCharacter === "string") {
    add(
      registerOnTypeFormattingProvider({
        extensionId,
        selector,
        firstTriggerCharacter: onType.firstTriggerCharacter,
        moreTriggerCharacter: stringArray(onType.moreTriggerCharacter),
      })
    )
  }

  const semantic = capabilityObject(capabilities, "semanticTokensProvider")
  const legend = semantic?.legend as { tokenTypes?: unknown; tokenModifiers?: unknown } | undefined
  if (semantic && Array.isArray(legend?.tokenTypes) && Array.isArray(legend?.tokenModifiers)) {
    if (semantic.full) {
      add(
        registerDocumentSemanticTokensProvider({
          extensionId,
          selector,
          legend: {
            tokenTypes: legend.tokenTypes as string[],
            tokenModifiers: legend.tokenModifiers as string[],
          },
        })
      )
    }
    if (semantic.range) {
      add(
        registerDocumentRangeSemanticTokensProvider({
          extensionId,
          selector,
          legend: {
            tokenTypes: legend.tokenTypes as string[],
            tokenModifiers: legend.tokenModifiers as string[],
          },
          range: true,
        })
      )
    }
  }
  if (hasCapability(capabilities, "inlayHintProvider"))
    add(registerInlayHintsProvider({ extensionId, selector }))
  if (hasCapability(capabilities, "callHierarchyProvider"))
    add(registerCallHierarchyProvider({ extensionId, selector }))
  if (hasCapability(capabilities, "typeHierarchyProvider"))
    add(registerTypeHierarchyProvider({ extensionId, selector }))
  if (hasCapability(capabilities, "linkedEditingRangeProvider"))
    add(registerLinkedEditingRangeProvider({ extensionId, selector }))

  return {
    dispose() {
      removeRoute()
      unregisterByExtension(extensionId)
      for (const disposable of disposables) disposable.dispose()
    },
  }
}
