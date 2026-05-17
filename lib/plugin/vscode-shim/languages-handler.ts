/**
 * Renderer-side handlers for `languages:*` and `window:*` RPC methods
 * coming from the VS Code extension sidecar. Each handler routes the
 * sidecar's request into the existing `monaco-bridge.ts` register/setter
 * functions and surfaces a JSON-serialisable response.
 *
 * Wired into the dispatcher by `setup-handlers.ts`. Splitting the table
 * out of `setup-handlers.ts` keeps the giant kind→register switch off
 * the main lifecycle file.
 */

import {
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
  setDecorations,
  setDiagnostics,
  unregisterByExtension,
  unregisterByToken,
  getActiveEditorSnapshot,
} from "./monaco-bridge"

type RegisterFn = (req: unknown) => { token: string; dispose(): void }

/**
 * Map from VS Code provider kind (the sidecar's discriminator) to the
 * matching `monaco-bridge` register function. Adding a new provider
 * type is a single-line entry here plus a new register function on the
 * bridge — no churn in setup-handlers.ts.
 */
const PROVIDER_REGISTRY: Record<string, RegisterFn> = {
  completionItem: (req) => registerCompletionItemProvider(req as never),
  hover: (req) => registerHoverProvider(req as never),
  definition: (req) => registerDefinitionProvider(req as never),
  references: (req) => registerReferenceProvider(req as never),
  documentFormatting: (req) => registerDocumentFormattingProvider(req as never),
  documentRangeFormatting: (req) => registerDocumentRangeFormattingProvider(req as never),
  codeLens: (req) => registerCodeLensProvider(req as never),
  codeActions: (req) => registerCodeActionsProvider(req as never),
  rename: (req) => registerRenameProvider(req as never),
  documentSymbol: (req) => registerDocumentSymbolProvider(req as never),
  inlineCompletion: (req) => registerInlineCompletionProvider(req as never),
  signatureHelp: (req) => registerSignatureHelpProvider(req as never),
  workspaceSymbol: (req) => registerWorkspaceSymbolProvider(req as never),
  color: (req) => registerColorProvider(req as never),
  foldingRange: (req) => registerFoldingRangeProvider(req as never),
  selectionRange: (req) => registerSelectionRangeProvider(req as never),
  documentLink: (req) => registerDocumentLinkProvider(req as never),
  onTypeFormatting: (req) => registerOnTypeFormattingProvider(req as never),
  documentSemanticTokens: (req) => registerDocumentSemanticTokensProvider(req as never),
  documentRangeSemanticTokens: (req) => registerDocumentRangeSemanticTokensProvider(req as never),
  inlayHints: (req) => registerInlayHintsProvider(req as never),
  callHierarchy: (req) => registerCallHierarchyProvider(req as never),
  typeHierarchy: (req) => registerTypeHierarchyProvider(req as never),
  linkedEditingRange: (req) => registerLinkedEditingRangeProvider(req as never),
}

export interface LanguagesRegisterPayload {
  kind: keyof typeof PROVIDER_REGISTRY | (string & {})
  extensionId: string
  selector?: string[]
  // Extra kind-specific fields ride along as `unknown`; the bridge
  // register function consumes them via the `as never` cast above.
  [key: string]: unknown
}

export interface LanguagesUnregisterPayload {
  token: string
}

export interface LanguagesSetDiagnosticsPayload {
  extensionId: string
  uri: string
  markers: unknown[]
}

export interface LanguagesRegisterDecorationTypePayload {
  extensionId: string
  options: unknown
}

export interface LanguagesSetDecorationsPayload {
  editorId: string
  typeId: string
  decorations: unknown[]
}

export interface ExtensionCleanupPayload {
  extensionId: string
}

export function handleLanguagesRegister(payload: LanguagesRegisterPayload): { token: string } {
  const register = PROVIDER_REGISTRY[payload.kind as string]
  if (!register) {
    throw new Error(`languages:register — unknown provider kind: ${payload.kind}`)
  }
  const { token } = register(payload)
  return { token }
}

export function handleLanguagesUnregister(payload: LanguagesUnregisterPayload): {
  removed: boolean
} {
  return { removed: unregisterByToken(payload.token) }
}

export function handleLanguagesSetDiagnostics(payload: LanguagesSetDiagnosticsPayload): void {
  setDiagnostics({
    extensionId: payload.extensionId,
    uri: payload.uri,
    markers: payload.markers as never,
  })
}

export function handleLanguagesRegisterDecorationType(
  payload: LanguagesRegisterDecorationTypePayload
): { typeId: string } {
  const { typeId } = registerDecorationType({
    extensionId: payload.extensionId,
    options: payload.options as never,
  })
  return { typeId }
}

export function handleLanguagesSetDecorations(payload: LanguagesSetDecorationsPayload): void {
  setDecorations({
    editorId: payload.editorId,
    typeId: payload.typeId,
    decorations: payload.decorations as never,
  })
}

export function handleExtensionCleanup(payload: ExtensionCleanupPayload): { removed: number } {
  return { removed: unregisterByExtension(payload.extensionId) }
}

export function handleWindowActiveTextEditorGet(): ReturnType<typeof getActiveEditorSnapshot> {
  return getActiveEditorSnapshot()
}

/** Exposed for tests + diagnostics. */
export function listSupportedLanguagesKinds(): string[] {
  return Object.keys(PROVIDER_REGISTRY).sort()
}
