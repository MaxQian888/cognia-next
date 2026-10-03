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
  registerDeclarationProvider,
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
  disposeLanguageConfiguration,
  setDecorations,
  setDiagnostics,
  setDocumentLanguage,
  setLanguageConfiguration,
  unregisterByExtension,
  unregisterByToken,
  getActiveEditorSnapshot,
} from "./monaco-bridge"

type RegisterFn = (req: unknown) => { token: string; supported: boolean; dispose(): void }

/**
 * Map from VS Code provider kind (the sidecar's discriminator) to the
 * matching `monaco-bridge` register function. The extension host's
 * `vscode.languages` sends exactly these kinds; `languages-handler.test.ts`
 * reads the sidecar source to keep the two lists equal. Adding a new provider
 * type is a single-line entry here plus a new register function on the
 * bridge — no churn in setup-handlers.ts.
 */
const PROVIDER_REGISTRY: Record<string, RegisterFn> = {
  completionItem: (req) => registerCompletionItemProvider(req as never),
  hover: (req) => registerHoverProvider(req as never),
  definition: (req) => registerDefinitionProvider(req as never),
  declaration: (req) => registerDeclarationProvider(req as never),
  typeDefinition: (req) => registerTypeDefinitionProvider(req as never),
  implementation: (req) => registerImplementationProvider(req as never),
  references: (req) => registerReferenceProvider(req as never),
  documentHighlight: (req) => registerDocumentHighlightProvider(req as never),
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

/**
 * Register a provider. `supported: false` means this editor has no such
 * feature (call and type hierarchy); the registration is kept, inert.
 */
export function handleLanguagesRegister(payload: LanguagesRegisterPayload): {
  token: string
  supported: boolean
} {
  const register = PROVIDER_REGISTRY[payload.kind as string]
  if (!register) {
    throw new Error(`languages:register — unknown provider kind: ${payload.kind}`)
  }
  const { token, supported } = register(payload)
  return { token, supported }
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

export function handleSetLanguageConfiguration(payload: {
  extensionId: string
  handle: string
  language: string
  configuration: unknown
}): null {
  setLanguageConfiguration(payload)
  return null
}

export function handleDisposeLanguageConfiguration(payload: { handle: string }): {
  removed: boolean
} {
  return { removed: disposeLanguageConfiguration(payload.handle) }
}

export function handleSetTextDocumentLanguage(payload: { uri: string; languageId: string }): {
  changed: boolean
} {
  return { changed: setDocumentLanguage(payload.uri, payload.languageId) }
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
