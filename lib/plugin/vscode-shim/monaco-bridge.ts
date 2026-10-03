/**
 * Monaco bridge for the VS Code reuse layer.
 *
 * VS Code itself is built on Monaco — every `vscode.languages.*` provider
 * registration, `window.createTextEditorDecorationType`, semantic-token
 * provider, code-lens provider, etc. has a 1:1 Monaco analogue. This
 * module is the renderer-side adapter: it accepts registration RPCs from
 * the sidecar, forwards them to `monaco.languages.*` / `monaco.editor`,
 * and routes invocations back to the sidecar.
 *
 * Design:
 *   - `MonacoApi` interface decouples the bridge from `monaco-editor`
 *     directly so we can unit-test it.
 *   - Active-editor tracking exposes Skills/Canvas/Artifact Monaco
 *     surfaces as `vscode.window.activeTextEditor` to extensions.
 *   - Every registration returns a `Disposable` so the sidecar can clean
 *     up when the extension deactivates.
 *
 * Public surface:
 *   - `configureMonacoBridge({ monacoApi, dispatchRpc })`
 *   - `notifyEditorMounted(editor)` — Skills/Canvas calls on mount.
 *   - `notifyEditorUnmounted(editor)` — Skills/Canvas calls on unmount.
 *   - `notifyActiveEditorChanged(editor | null)` — when focus shifts.
 *   - `registerCompletionItemProvider(req)` / hover / definition / …
 *   - `setDiagnostics(req)` / `setDecorations(req)`
 *   - `getActiveEditorSnapshot()` — for the sidecar's `vscode.window.activeTextEditor`.
 */

import { nanoid } from "nanoid"

import {
  monacoPositionToVscode,
  monacoRangeToVscode,
  vscodeCodeLensToMonaco,
  vscodeColorInformationToMonaco,
  vscodeCompletionResultToMonaco,
  vscodeDocumentLinkToMonaco,
  vscodeDocumentSymbolToMonaco,
  vscodeFoldingRangeToMonaco,
  vscodeHoverToMonaco,
  vscodeInlayHintToMonaco,
  vscodeInlineCompletionResultToMonaco,
  vscodeLocationsToMonaco,
  vscodeSelectionRangeToMonaco,
  vscodeSemanticTokensToMonaco,
  vscodeSignatureHelpToMonaco,
  vscodeRangeToMonaco,
  vscodeTextEditsToMonaco,
  vscodeWorkspaceEditToMonaco,
  type VscodeCodeLens,
  type VscodeColorInformation,
  type VscodeCompletionResult,
  type VscodeDocumentLink,
  type VscodeDocumentSymbol,
  type VscodeFoldingRange,
  type VscodeHover,
  type VscodeInlayHint,
  type VscodeInlineCompletionResult,
  type VscodeLocation,
  type VscodeRange as AdapterVscodeRange,
  type VscodeSelectionRange,
  type VscodeSemanticTokens,
  type VscodeSignatureHelp,
  type VscodeTextEdit,
  type VscodeWorkspaceEdit,
} from "./lsp-protocol-adapter"
import {
  monacoMarkersToVscodeDiagnostics,
  toMonacoCodeActions,
  toMonacoCodeLenses,
  toMonacoColorPresentations,
  toMonacoCompletions,
  toMonacoDocumentHighlights,
  toMonacoDocumentSymbols,
  toMonacoFoldingRanges,
  toMonacoHover,
  toMonacoInlayHints,
  toMonacoLinks,
  toMonacoLocations,
  toMonacoSelectionRanges,
  toMonacoSemanticTokens,
  toMonacoSignatureHelp,
  toMonacoWorkspaceEdit,
  wordRangeBefore,
  type MonacoRuntime,
  type WireCodeAction,
} from "./monaco-results"

// ────────────────────────────────────────────────────────────────────────
// Type aliases (Monaco-shaped, intentionally minimal)
// ────────────────────────────────────────────────────────────────────────

export interface MonacoPosition {
  lineNumber: number
  column: number
}

export interface MonacoRange {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

export interface MonacoTextModel {
  uri: string
  language: string
  getValue(): string
  setValue(value: string): void
  getLineCount(): number
  getLineContent(line: number): string
  isDisposed(): boolean
  /** Monaco's version id; increases with every edit. */
  getVersionId?(): number
}

export interface MonacoEditor {
  /** Stable opaque id for matching active/notifications. */
  id: string
  getModel(): MonacoTextModel | null
  getPosition(): MonacoPosition | null
  getSelection(): MonacoRange | null
  /** Every cursor, with direction: `anchor` is where the selection started. */
  getSelections?(): Array<{ anchor: MonacoPosition; active: MonacoPosition }>
  /** Replace the editor's text via Monaco's text-edit API. */
  applyEdits(edits: MonacoTextEdit[]): void
  setDecorations(typeId: string, decorations: MonacoDecoration[]): void
}

export interface MonacoTextEdit {
  range: MonacoRange
  text: string
}

export interface MonacoDecoration {
  range: MonacoRange
  options: MonacoDecorationOptions
}

export interface MonacoDecorationOptions {
  className?: string
  hoverMessage?: string
  glyphMarginClassName?: string
  isWholeLine?: boolean
  /** Inline CSS for the decorated range. */
  inlineClassName?: string
  /** Marker type used by setModelMarkers (error / warning / info / hint). */
  severity?: "error" | "warning" | "info" | "hint"
}

export interface MonacoCompletionItem {
  label: string | { label: string; detail?: string; description?: string }
  /**
   * Monaco's numeric `CompletionItemKind` enum value (`Method = 0`,
   * `Function = 1`, ...). The `lsp-protocol-adapter` translates VS Code's
   * 1..25 enum into Monaco's enum before items reach this shape.
   */
  kind?: number
  tags?: number[]
  detail?: string
  documentation?: string
  insertText: string
  /**
   * Monaco's `CompletionItemInsertTextRule` bitmask. `InsertAsSnippet = 4`
   * is the only value cognia emits — see `lsp-protocol-adapter` for the
   * VS Code `insertTextFormat` translation.
   */
  insertTextRules?: number
  range?: MonacoRange | { insert: MonacoRange; replace: MonacoRange }
  filterText?: string
  sortText?: string
  preselect?: boolean
  commitCharacters?: string[]
  additionalTextEdits?: MonacoTextEdit[]
  command?: { id: string; title: string; arguments?: unknown[] }
}

export interface MonacoHover {
  contents: string[]
  range?: MonacoRange
}

export interface MonacoCodeLens {
  range: MonacoRange
  command?: { id: string; title: string; arguments?: unknown[] }
}

export interface MonacoLocation {
  uri: string
  range: MonacoRange
}

export interface MonacoMarker {
  severity: "error" | "warning" | "info" | "hint"
  message: string
  range: MonacoRange
  source?: string
}

// ────────────────────────────────────────────────────────────────────────
// Provider request shapes (what the sidecar sends to the bridge)
// ────────────────────────────────────────────────────────────────────────

export interface BaseProviderRequest {
  /** Owning extension id. Used for bulk-cleanup. */
  extensionId: string
  /** Document selector: language ids or filters. `["*"]` matches all. */
  selector: MonacoLanguageSelector
  /**
   * The registrant's own id for the provider. The extension host sends its
   * provider token, and every call carries it back so the host can find the
   * provider; a standalone LSP route leaves it out and gets a fresh one.
   */
  token?: string
}

export interface CompletionProviderRequest extends BaseProviderRequest {
  triggerCharacters?: string[]
}

// Type aliases for providers that share the BaseProviderRequest shape
// exactly. Using `type X = Y` rather than `interface X extends Y {}` keeps
// the @typescript-eslint/no-empty-object-type rule happy while preserving
// the named-type vocabulary the call sites use.
export type HoverProviderRequest = BaseProviderRequest
export type DefinitionProviderRequest = BaseProviderRequest
export type DocumentHighlightProviderRequest = BaseProviderRequest
export type ReferenceProviderRequest = BaseProviderRequest
export type FormattingProviderRequest = BaseProviderRequest
export type RangeFormattingProviderRequest = BaseProviderRequest
export type RenameProviderRequest = BaseProviderRequest
export type DocumentSymbolProviderRequest = BaseProviderRequest

export interface CodeLensProviderRequest extends BaseProviderRequest {
  eventEmitterId?: string
}
export interface CodeActionsProviderRequest extends BaseProviderRequest {
  providedKinds?: string[]
}

// Request shapes for the additional Tier-2 providers wired in Phase B.
export interface InlineCompletionProviderRequest extends BaseProviderRequest {
  triggerCharacters?: string[]
}
export interface SignatureHelpProviderRequest extends BaseProviderRequest {
  triggerCharacters?: string[]
  retriggerCharacters?: string[]
}
export type WorkspaceSymbolProviderRequest = Omit<BaseProviderRequest, "selector">
export type ColorProviderRequest = BaseProviderRequest
export type FoldingRangeProviderRequest = BaseProviderRequest
export type SelectionRangeProviderRequest = BaseProviderRequest
export type DocumentLinkProviderRequest = BaseProviderRequest
export interface OnTypeFormattingProviderRequest extends BaseProviderRequest {
  firstTriggerCharacter: string
  moreTriggerCharacter?: string[]
}
export interface SemanticTokensProviderRequest extends BaseProviderRequest {
  legend: { tokenTypes: string[]; tokenModifiers: string[] }
  range?: boolean
}
export type InlayHintsProviderRequest = BaseProviderRequest
export type CallHierarchyProviderRequest = BaseProviderRequest
export type TypeHierarchyProviderRequest = BaseProviderRequest
export type LinkedEditingRangeProviderRequest = BaseProviderRequest

// Generic untyped value shape used by the bag of new providers. Monaco's
// exact result types vary — the bridge only enforces array-vs-object at the
// call site, and the sidecar's shim is the source of truth for VS Code
// type semantics.
export type MonacoUnknownArray = unknown[]
export interface MonacoColorInformation {
  range: MonacoRange
  color: { red: number; green: number; blue: number; alpha: number }
}
export interface MonacoFoldingRange {
  start: number
  end: number
  kind?: string
}
export interface MonacoSelectionRange {
  range: MonacoRange
  parent?: MonacoSelectionRange
}
export interface MonacoDocumentLink {
  range: MonacoRange
  url?: string
  tooltip?: string
}
export interface MonacoInlayHint {
  position: MonacoPosition
  label: string
  kind?: "type" | "parameter"
}
export interface MonacoSemanticTokens {
  /** vscode-format: deltaLine, deltaStart, length, tokenType, tokenModifiers — chained. */
  data: number[]
  resultId?: string
}
export interface MonacoSignatureHelp {
  signatures: Array<{ label: string; documentation?: string; parameters?: unknown[] }>
  activeSignature: number
  activeParameter: number
}

// ────────────────────────────────────────────────────────────────────────
// Sidecar RPC dispatch
// ────────────────────────────────────────────────────────────────────────

/**
 * Function that proxies a provider invocation back to the sidecar's
 * extension code. The sidecar registered the provider; the bridge fires
 * this whenever Monaco needs a result.
 *
 * The protocol is intentionally string-based: every call routes through
 * `dispatchRpc(extensionId, method, payload)` so the sidecar can multiplex
 * one stdio stream across every registered provider.
 */
export type DispatchRpc = <T = unknown>(
  extensionId: string,
  method: string,
  payload: unknown,
  /** Monaco's token for the call; a route that can cancel forwards it. */
  cancellation?: MonacoCancellationToken
) => Promise<T>

/** What Monaco passes providers for cancellation. */
export interface MonacoCancellationToken {
  readonly isCancellationRequested: boolean
  onCancellationRequested(listener: () => unknown): { dispose(): void }
}

/** The parts of Monaco's `ITextModel` providers read. */
export interface MonacoProviderModel {
  /** A `monaco.Uri`; its `toString()` is the document URI. */
  uri: unknown
  getVersionId?(): number
  getWordUntilPosition?(position: MonacoPosition): { startColumn: number; endColumn: number }
}

/** A language filter, as VS Code and Monaco both accept. */
export interface MonacoLanguageFilter {
  language?: string
  scheme?: string
  pattern?: string | { base: string; pattern: string }
}

export type MonacoLanguageSelector = Array<string | MonacoLanguageFilter>

/**
 * `monaco.languages.register*Provider` names the bridge uses. Standalone
 * Monaco has no `registerCallHierarchyProvider` / `registerTypeHierarchyProvider`;
 * registering those is inert (`supported: false`).
 */
export type MonacoRegistrarName =
  | "registerCompletionItemProvider"
  | "registerHoverProvider"
  | "registerDefinitionProvider"
  | "registerDeclarationProvider"
  | "registerTypeDefinitionProvider"
  | "registerImplementationProvider"
  | "registerReferenceProvider"
  | "registerDocumentHighlightProvider"
  | "registerDocumentFormattingEditProvider"
  | "registerDocumentRangeFormattingEditProvider"
  | "registerOnTypeFormattingEditProvider"
  | "registerCodeLensProvider"
  | "registerCodeActionProvider"
  | "registerRenameProvider"
  | "registerDocumentSymbolProvider"
  | "registerInlineCompletionsProvider"
  | "registerSignatureHelpProvider"
  | "registerColorProvider"
  | "registerFoldingRangeProvider"
  | "registerSelectionRangeProvider"
  | "registerLinkProvider"
  | "registerDocumentSemanticTokensProvider"
  | "registerDocumentRangeSemanticTokensProvider"
  | "registerInlayHintsProvider"
  | "registerCallHierarchyProvider"
  | "registerTypeHierarchyProvider"
  | "registerLinkedEditingRangeProvider"

export interface MonacoApi {
  /** `monaco.languages`; providers are plain objects in Monaco's shapes. */
  languages: Partial<
    Record<MonacoRegistrarName, (selector: MonacoLanguageSelector, provider: object) => Disposable>
  >
  editor: {
    /**
     * Set `owner`'s markers on the model at `uri`. Returns `false` when no
     * model is open there; the bridge applies them when one opens.
     */
    setModelMarkers(uri: string, owner: string, markers: MonacoMarker[]): boolean
  }
  /** `monaco.Uri.parse`. */
  parseUri(uri: string): unknown
  /** `monaco.languages.setLanguageConfiguration`. */
  setLanguageConfiguration?(languageId: string, configuration: unknown): Disposable
  /** `monaco.editor.setModelLanguage` on the model at `uri`; `false` when none is open. */
  setModelLanguage?(uri: string, languageId: string): boolean
}

/** What a provider registration hands back. */
export interface ProviderRegistration {
  token: string
  /** `false` when this Monaco build has no such provider API; the registration is inert. */
  supported: boolean
  dispose(): void
}

export interface Disposable {
  dispose(): void
}

// ────────────────────────────────────────────────────────────────────────
// Internal state
// ────────────────────────────────────────────────────────────────────────

let monacoApi: MonacoApi | null = null
let dispatchRpc: DispatchRpc | null = null
const directDispatchRoutes = new Map<string, DispatchRpc>()

const editors = new Map<string, MonacoEditor>()
let activeEditorId: string | null = null

interface RegistrationRecord {
  extensionId: string
  disposable: Disposable
  /** Token cognia gives the sidecar so it can call `unregister(token)`. */
  token: string
}

const registrations = new Map<string, RegistrationRecord>()
/** Language configurations extensions set, by the handle they gave. */
const languageConfigurations = new Map<string, { extensionId: string; disposable: Disposable }>()
/** URI → owner → markers. */
const diagnostics = new Map<string, Map<string, MonacoMarker[]>>()
const decorationTypes = new Map<string, { extensionId: string; className?: string }>()
const workspaceSymbolProviders = new Map<
  string,
  { extensionId: string; invoke: (query: string) => Promise<unknown[] | null> }
>()

const activeEditorListeners = new Set<(editor: MonacoEditor | null) => void>()
const editorChangeListeners = new Set<(event: MonacoEditorChangeEvent) => void>()

export interface MonacoEditorChangeEvent {
  editorId: string
  uri: string
  kind: "open" | "close" | "change-selection" | "change-content" | "change-language"
}

// ────────────────────────────────────────────────────────────────────────
// Public surface
// ────────────────────────────────────────────────────────────────────────

export function configureMonacoBridge(input: {
  monacoApi: MonacoApi
  dispatchRpc: DispatchRpc
}): void {
  monacoApi = input.monacoApi
  dispatchRpc = input.dispatchRpc
}

/**
 * Register a renderer-local provider transport.
 *
 * VS Code extensions continue through the configured sidecar dispatcher;
 * standalone LSP servers use this narrow route so they can reuse the exact
 * same Monaco provider adapters without pretending to be an extension.
 */
export function registerProviderDispatchRoute(extensionId: string, route: DispatchRpc): () => void {
  directDispatchRoutes.set(extensionId, route)
  return () => {
    if (directDispatchRoutes.get(extensionId) === route) directDispatchRoutes.delete(extensionId)
  }
}

function dispatchProviderRpc<T>(
  extensionId: string,
  method: string,
  payload: unknown,
  cancellation?: MonacoCancellationToken
): Promise<T> {
  const route = directDispatchRoutes.get(extensionId) ?? dispatchRpc
  if (!route) {
    return Promise.reject(new Error("monaco-bridge provider dispatcher is not configured"))
  }
  // Monaco already gave up on this call; an empty answer is what it expects.
  if (cancellation?.isCancellationRequested) return Promise.resolve(null as T)
  return route<T>(extensionId, method, payload, cancellation)
}

/**
 * Called by Skills / Canvas / Artifact when a Monaco editor mounts. The
 * bridge becomes aware of the editor; the sidecar can subsequently use
 * the editor's URI as `vscode.window.activeTextEditor`.
 */
export function notifyEditorMounted(editor: MonacoEditor): void {
  editors.set(editor.id, editor)
  const model = editor.getModel()
  if (model) {
    applyStoredDiagnostics(model.uri)
    fireEditorChange({ editorId: editor.id, uri: model.uri, kind: "open" })
  }
}

export function notifyEditorUnmounted(editorId: string): void {
  const editor = editors.get(editorId)
  if (!editor) return
  const model = editor.getModel()
  editors.delete(editorId)
  if (activeEditorId === editorId) {
    activeEditorId = null
    fireActiveEditorChanged(null)
  }
  if (model) {
    fireEditorChange({ editorId, uri: model.uri, kind: "close" })
  }
}

export function notifyActiveEditorChanged(editorId: string | null): void {
  if (activeEditorId === editorId) return
  activeEditorId = editorId
  const editor = editorId ? (editors.get(editorId) ?? null) : null
  fireActiveEditorChanged(editor)
}

export function notifySelectionChanged(editorId: string): void {
  const editor = editors.get(editorId)
  if (!editor) return
  const model = editor.getModel()
  if (!model) return
  fireEditorChange({ editorId, uri: model.uri, kind: "change-selection" })
}

export function notifyContentChanged(editorId: string): void {
  const editor = editors.get(editorId)
  if (!editor) return
  const model = editor.getModel()
  if (!model) return
  fireEditorChange({ editorId, uri: model.uri, kind: "change-content" })
}

export function onActiveEditorChanged(listener: (editor: MonacoEditor | null) => void): () => void {
  activeEditorListeners.add(listener)
  return () => activeEditorListeners.delete(listener)
}

export function onEditorChange(listener: (event: MonacoEditorChangeEvent) => void): () => void {
  editorChangeListeners.add(listener)
  return () => editorChangeListeners.delete(listener)
}

/** The focused editor's id, or `null` when no tracked editor has focus. */
export function getActiveEditorId(): string | null {
  return activeEditorId && editors.has(activeEditorId) ? activeEditorId : null
}

export function getActiveEditorSnapshot(): {
  editorId: string
  uri: string
  language: string
  selection: MonacoRange | null
  position: MonacoPosition | null
} | null {
  if (!activeEditorId) return null
  const editor = editors.get(activeEditorId)
  if (!editor) return null
  const model = editor.getModel()
  if (!model) return null
  return {
    editorId: editor.id,
    uri: model.uri,
    language: model.language,
    selection: editor.getSelection(),
    position: editor.getPosition(),
  }
}

export function getEditorById(editorId: string): MonacoEditor | undefined {
  return editors.get(editorId)
}

// ────────────────────────────────────────────────────────────────────────
// Provider registrations. Each one registers with Monaco, and when Monaco
// asks, sends the document's URI and version plus the call's arguments to
// whoever registered it (the extension host, or a standalone LSP route),
// then turns the answer into what Monaco accepts (`monaco-results.ts`).
// ────────────────────────────────────────────────────────────────────────

function documentPayload(token: string, model: MonacoProviderModel) {
  const version = model.getVersionId?.()
  return { token, uri: String(model.uri), ...(version === undefined ? {} : { version }) }
}

function call<T>(
  req: { extensionId: string },
  method: string,
  payload: unknown,
  cancellation?: MonacoCancellationToken
): Promise<T> {
  return dispatchProviderRpc<T>(req.extensionId, method, payload, cancellation)
}

function runtime(): MonacoRuntime {
  return { parseUri: (uri) => monacoApi!.parseUri(uri) }
}

/**
 * Register `provider` through Monaco's `registrar`. A registrar this Monaco
 * build does not have (call and type hierarchy: VS Code has views for them,
 * standalone Monaco does not) leaves the registration inert: the token is
 * kept, so the sidecar can unregister it, and `supported` says it does
 * nothing.
 */
function register(
  req: BaseProviderRequest,
  registrar: MonacoRegistrarName,
  build: (token: string) => object
): ProviderRegistration {
  assertConfigured()
  const token = req.token ?? nanoid()
  const registerWith = monacoApi!.languages[registrar]
  if (typeof registerWith !== "function") {
    return registerToken(token, req.extensionId, { dispose() {} }, false)
  }
  return registerToken(token, req.extensionId, registerWith(req.selector, build(token)), true)
}

export function registerCompletionItemProvider(req: CompletionProviderRequest) {
  return register(req, "registerCompletionItemProvider", (token) => ({
    triggerCharacters: req.triggerCharacters,
    provideCompletionItems: async (
      model: MonacoProviderModel,
      position: MonacoPosition,
      context?: { triggerKind: number; triggerCharacter?: string },
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<VscodeCompletionResult | null>(
        req,
        "provideCompletionItems",
        {
          ...documentPayload(token, model),
          position: monacoPositionToVscode(position),
          // Monaco's and VS Code's CompletionTriggerKind share their values.
          context: {
            triggerKind: context?.triggerKind ?? 0,
            ...(context?.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}),
          },
        },
        cancellation
      )
      const adapted = vscodeCompletionResultToMonaco(result)
      return adapted ? toMonacoCompletions(adapted, wordRangeBefore(model, position)) : null
    },
  }))
}

export function registerHoverProvider(req: HoverProviderRequest) {
  return register(req, "registerHoverProvider", (token) => ({
    provideHover: async (
      model: MonacoProviderModel,
      position: MonacoPosition,
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<VscodeHover | null>(
        req,
        "provideHover",
        { ...documentPayload(token, model), position: monacoPositionToVscode(position) },
        cancellation
      )
      return result ? toMonacoHover(vscodeHoverToMonaco(result)) : null
    },
  }))
}

type LocationRegistrar =
  | "registerDefinitionProvider"
  | "registerDeclarationProvider"
  | "registerTypeDefinitionProvider"
  | "registerImplementationProvider"

function registerLocationProvider(
  req: BaseProviderRequest,
  registrar: LocationRegistrar,
  monacoMethod: string,
  method: string
) {
  return register(req, registrar, (token) => ({
    [monacoMethod]: async (
      model: MonacoProviderModel,
      position: MonacoPosition,
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<VscodeLocation[] | VscodeLocation | null>(
        req,
        method,
        { ...documentPayload(token, model), position: monacoPositionToVscode(position) },
        cancellation
      )
      if (result == null) return null
      return toMonacoLocations(
        runtime(),
        vscodeLocationsToMonaco(Array.isArray(result) ? result : [result])
      )
    },
  }))
}

export function registerDefinitionProvider(req: DefinitionProviderRequest) {
  return registerLocationProvider(
    req,
    "registerDefinitionProvider",
    "provideDefinition",
    "provideDefinition"
  )
}

export function registerDeclarationProvider(req: DefinitionProviderRequest) {
  return registerLocationProvider(
    req,
    "registerDeclarationProvider",
    "provideDeclaration",
    "provideDeclaration"
  )
}

export function registerTypeDefinitionProvider(req: DefinitionProviderRequest) {
  return registerLocationProvider(
    req,
    "registerTypeDefinitionProvider",
    "provideTypeDefinition",
    "provideTypeDefinition"
  )
}

export function registerImplementationProvider(req: DefinitionProviderRequest) {
  return registerLocationProvider(
    req,
    "registerImplementationProvider",
    "provideImplementation",
    "provideImplementation"
  )
}

export function registerReferenceProvider(req: ReferenceProviderRequest) {
  return register(req, "registerReferenceProvider", (token) => ({
    provideReferences: async (
      model: MonacoProviderModel,
      position: MonacoPosition,
      context?: { includeDeclaration: boolean },
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<VscodeLocation[] | null>(
        req,
        "provideReferences",
        {
          ...documentPayload(token, model),
          position: monacoPositionToVscode(position),
          context: { includeDeclaration: context?.includeDeclaration ?? true },
        },
        cancellation
      )
      return result ? toMonacoLocations(runtime(), vscodeLocationsToMonaco(result)) : null
    },
  }))
}

export function registerDocumentHighlightProvider(req: DocumentHighlightProviderRequest) {
  return register(req, "registerDocumentHighlightProvider", (token) => ({
    provideDocumentHighlights: async (
      model: MonacoProviderModel,
      position: MonacoPosition,
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<Array<{ range: AdapterVscodeRange; kind?: number }> | null>(
        req,
        "provideDocumentHighlights",
        { ...documentPayload(token, model), position: monacoPositionToVscode(position) },
        cancellation
      )
      return result ? toMonacoDocumentHighlights(result) : null
    },
  }))
}

function formattingOptions(options?: { tabSize: number; insertSpaces: boolean }) {
  return { tabSize: options?.tabSize ?? 2, insertSpaces: options?.insertSpaces ?? true }
}

export function registerDocumentFormattingProvider(req: FormattingProviderRequest) {
  return register(req, "registerDocumentFormattingEditProvider", (token) => ({
    provideDocumentFormattingEdits: async (
      model: MonacoProviderModel,
      options?: { tabSize: number; insertSpaces: boolean },
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<VscodeTextEdit[] | null>(
        req,
        "provideDocumentFormattingEdits",
        { ...documentPayload(token, model), options: formattingOptions(options) },
        cancellation
      )
      return result ? vscodeTextEditsToMonaco(result) : null
    },
  }))
}

export function registerDocumentRangeFormattingProvider(req: RangeFormattingProviderRequest) {
  return register(req, "registerDocumentRangeFormattingEditProvider", (token) => ({
    provideDocumentRangeFormattingEdits: async (
      model: MonacoProviderModel,
      range: MonacoRange,
      options?: { tabSize: number; insertSpaces: boolean },
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<VscodeTextEdit[] | null>(
        req,
        "provideDocumentRangeFormattingEdits",
        {
          ...documentPayload(token, model),
          range: monacoRangeToVscode(range),
          options: formattingOptions(options),
        },
        cancellation
      )
      return result ? vscodeTextEditsToMonaco(result) : null
    },
  }))
}

export function registerOnTypeFormattingProvider(req: OnTypeFormattingProviderRequest) {
  return register(req, "registerOnTypeFormattingEditProvider", (token) => ({
    autoFormatTriggerCharacters: [req.firstTriggerCharacter, ...(req.moreTriggerCharacter ?? [])],
    provideOnTypeFormattingEdits: async (
      model: MonacoProviderModel,
      position: MonacoPosition,
      ch: string,
      options?: { tabSize: number; insertSpaces: boolean },
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<VscodeTextEdit[] | null>(
        req,
        "provideOnTypeFormattingEdits",
        {
          ...documentPayload(token, model),
          position: monacoPositionToVscode(position),
          ch,
          options: formattingOptions(options),
        },
        cancellation
      )
      return result ? vscodeTextEditsToMonaco(result) : null
    },
  }))
}

export function registerCodeLensProvider(req: CodeLensProviderRequest) {
  return register(req, "registerCodeLensProvider", (token) => ({
    provideCodeLenses: async (
      model: MonacoProviderModel,
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<VscodeCodeLens[] | null>(
        req,
        "provideCodeLenses",
        documentPayload(token, model),
        cancellation
      )
      return result ? toMonacoCodeLenses(result.map(vscodeCodeLensToMonaco)) : null
    },
  }))
}

export function registerCodeActionsProvider(req: CodeActionsProviderRequest) {
  return register(req, "registerCodeActionProvider", (token) => ({
    provideCodeActions: async (
      model: MonacoProviderModel,
      range: MonacoRange,
      context?: {
        markers: Parameters<typeof monacoMarkersToVscodeDiagnostics>[0]
        only?: string
        trigger?: number
      },
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<WireCodeAction[] | null>(
        req,
        "provideCodeActions",
        {
          ...documentPayload(token, model),
          range: monacoRangeToVscode(range),
          // Monaco's CodeActionTriggerType and VS Code's CodeActionTriggerKind share values.
          context: {
            diagnostics: monacoMarkersToVscodeDiagnostics(context?.markers ?? []),
            ...(context?.only ? { only: context.only } : {}),
            triggerKind: context?.trigger ?? 1,
          },
        },
        cancellation
      )
      return result ? toMonacoCodeActions(runtime(), result) : null
    },
  }))
}

export function registerRenameProvider(req: RenameProviderRequest) {
  return register(req, "registerRenameProvider", (token) => ({
    provideRenameEdits: async (
      model: MonacoProviderModel,
      position: MonacoPosition,
      newName: string,
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<VscodeTextEdit[] | VscodeWorkspaceEdit | null>(
        req,
        "provideRenameEdits",
        { ...documentPayload(token, model), position: monacoPositionToVscode(position), newName },
        cancellation
      )
      if (!result) return null
      const edit = Array.isArray(result)
        ? vscodeWorkspaceEditToMonaco({ changes: { [String(model.uri)]: result } })
        : vscodeWorkspaceEditToMonaco(result)
      return toMonacoWorkspaceEdit(runtime(), edit)
    },
    resolveRenameLocation: async (
      model: MonacoProviderModel,
      position: MonacoPosition,
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<
        { range: AdapterVscodeRange; text: string } | { rejectReason: string } | null
      >(
        req,
        "prepareRename",
        { ...documentPayload(token, model), position: monacoPositionToVscode(position) },
        cancellation
      )
      // No answer: Monaco renames the word at the cursor.
      if (!result) return undefined
      if ("rejectReason" in result) {
        return {
          range: wordRangeBefore(model, position),
          text: "",
          rejectReason: result.rejectReason,
        }
      }
      return { range: vscodeRangeToMonaco(result.range), text: result.text }
    },
  }))
}

export function registerDocumentSymbolProvider(req: DocumentSymbolProviderRequest) {
  return register(req, "registerDocumentSymbolProvider", (token) => ({
    provideDocumentSymbols: async (
      model: MonacoProviderModel,
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<VscodeDocumentSymbol[] | null>(
        req,
        "provideDocumentSymbols",
        documentPayload(token, model),
        cancellation
      )
      return result ? toMonacoDocumentSymbols(result.map(vscodeDocumentSymbolToMonaco)) : null
    },
  }))
}

export function registerInlineCompletionProvider(req: InlineCompletionProviderRequest) {
  return register(req, "registerInlineCompletionsProvider", (token) => ({
    triggerCharacters: req.triggerCharacters,
    provideInlineCompletions: async (
      model: MonacoProviderModel,
      position: MonacoPosition,
      context?: { triggerKind: number },
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<VscodeInlineCompletionResult | null>(
        req,
        "provideInlineCompletionItems",
        {
          ...documentPayload(token, model),
          position: monacoPositionToVscode(position),
          // Monaco: Automatic 0, Explicit 1. VS Code: Invoke 0, Automatic 1.
          context: { triggerKind: context?.triggerKind === 1 ? 0 : 1 },
        },
        cancellation
      )
      return vscodeInlineCompletionResultToMonaco(result)
    },
    // Results are plain data; nothing to release.
    disposeInlineCompletions: () => {},
    freeInlineCompletions: () => {},
  }))
}

export function registerSignatureHelpProvider(req: SignatureHelpProviderRequest) {
  return register(req, "registerSignatureHelpProvider", (token) => ({
    signatureHelpTriggerCharacters: req.triggerCharacters,
    signatureHelpRetriggerCharacters: req.retriggerCharacters,
    provideSignatureHelp: async (
      model: MonacoProviderModel,
      position: MonacoPosition,
      cancellation?: MonacoCancellationToken,
      context?: { triggerKind: number; triggerCharacter?: string; isRetrigger: boolean }
    ) => {
      const result = await call<VscodeSignatureHelp | null>(
        req,
        "provideSignatureHelp",
        {
          ...documentPayload(token, model),
          position: monacoPositionToVscode(position),
          // Monaco's and VS Code's SignatureHelpTriggerKind share their values.
          context: {
            triggerKind: context?.triggerKind ?? 1,
            ...(context?.triggerCharacter ? { triggerCharacter: context.triggerCharacter } : {}),
            isRetrigger: context?.isRetrigger ?? false,
          },
        },
        cancellation
      )
      return result ? toMonacoSignatureHelp(vscodeSignatureHelpToMonaco(result)) : null
    },
  }))
}

/**
 * Workspace symbol search has no Monaco equivalent (Monaco providers are
 * per model). The provider is kept here and queried by
 * {@link searchWorkspaceSymbols}, which cognia's search surfaces call.
 */
export function registerWorkspaceSymbolProvider(req: WorkspaceSymbolProviderRequest) {
  assertConfigured()
  const token = req.token ?? nanoid()
  workspaceSymbolProviders.set(token, {
    extensionId: req.extensionId,
    invoke: (query) =>
      dispatchProviderRpc<unknown[] | null>(req.extensionId, "provideWorkspaceSymbols", {
        token,
        query,
      }),
  })
  return registerToken(
    token,
    req.extensionId,
    {
      dispose() {
        workspaceSymbolProviders.delete(token)
      },
    },
    true
  )
}

/** Query every registered workspace symbol provider; one failing does not hide the rest. */
export async function searchWorkspaceSymbols(query: string): Promise<unknown[]> {
  const results: unknown[] = []
  for (const provider of workspaceSymbolProviders.values()) {
    try {
      const batch = await provider.invoke(query)
      if (Array.isArray(batch)) results.push(...batch)
    } catch (err) {
      console.warn("monaco-bridge: workspaceSymbolProvider failed:", err)
    }
  }
  return results
}

export function registerColorProvider(req: ColorProviderRequest) {
  return register(req, "registerColorProvider", (token) => ({
    provideDocumentColors: async (
      model: MonacoProviderModel,
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<VscodeColorInformation[] | null>(
        req,
        "provideDocumentColors",
        documentPayload(token, model),
        cancellation
      )
      return result ? result.map(vscodeColorInformationToMonaco) : null
    },
    provideColorPresentations: async (
      model: MonacoProviderModel,
      colorInfo: MonacoColorInformation,
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<Parameters<typeof toMonacoColorPresentations>[0] | null>(
        req,
        "provideColorPresentations",
        {
          ...documentPayload(token, model),
          colorInfo: { range: monacoRangeToVscode(colorInfo.range), color: colorInfo.color },
        },
        cancellation
      )
      return result ? toMonacoColorPresentations(result) : null
    },
  }))
}

export function registerFoldingRangeProvider(req: FoldingRangeProviderRequest) {
  return register(req, "registerFoldingRangeProvider", (token) => ({
    provideFoldingRanges: async (
      model: MonacoProviderModel,
      _context: unknown,
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<VscodeFoldingRange[] | null>(
        req,
        "provideFoldingRanges",
        documentPayload(token, model),
        cancellation
      )
      return result ? toMonacoFoldingRanges(result.map(vscodeFoldingRangeToMonaco)) : null
    },
  }))
}

export function registerSelectionRangeProvider(req: SelectionRangeProviderRequest) {
  return register(req, "registerSelectionRangeProvider", (token) => ({
    provideSelectionRanges: async (
      model: MonacoProviderModel,
      positions: MonacoPosition[],
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<VscodeSelectionRange[][] | null>(
        req,
        "provideSelectionRanges",
        { ...documentPayload(token, model), positions: positions.map(monacoPositionToVscode) },
        cancellation
      )
      return result
        ? toMonacoSelectionRanges(result.map((perPos) => perPos.map(vscodeSelectionRangeToMonaco)))
        : null
    },
  }))
}

export function registerDocumentLinkProvider(req: DocumentLinkProviderRequest) {
  return register(req, "registerLinkProvider", (token) => ({
    provideLinks: async (model: MonacoProviderModel, cancellation?: MonacoCancellationToken) => {
      const result = await call<{ links: VscodeDocumentLink[] } | null>(
        req,
        "provideDocumentLinks",
        documentPayload(token, model),
        cancellation
      )
      return result ? toMonacoLinks(runtime(), result.links.map(vscodeDocumentLinkToMonaco)) : null
    },
  }))
}

export function registerDocumentSemanticTokensProvider(req: SemanticTokensProviderRequest) {
  return register(req, "registerDocumentSemanticTokensProvider", (token) => ({
    getLegend: () => req.legend,
    provideDocumentSemanticTokens: async (
      model: MonacoProviderModel,
      _lastResultId: string | null,
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<VscodeSemanticTokens | null>(
        req,
        "provideDocumentSemanticTokens",
        documentPayload(token, model),
        cancellation
      )
      return result ? toMonacoSemanticTokens(vscodeSemanticTokensToMonaco(result)) : null
    },
    releaseDocumentSemanticTokens: () => {
      // Results are plain data; nothing to release.
    },
  }))
}

export function registerDocumentRangeSemanticTokensProvider(req: SemanticTokensProviderRequest) {
  return register(req, "registerDocumentRangeSemanticTokensProvider", (token) => ({
    getLegend: () => req.legend,
    provideDocumentRangeSemanticTokens: async (
      model: MonacoProviderModel,
      range: MonacoRange,
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<VscodeSemanticTokens | null>(
        req,
        "provideDocumentRangeSemanticTokens",
        { ...documentPayload(token, model), range: monacoRangeToVscode(range) },
        cancellation
      )
      return result ? toMonacoSemanticTokens(vscodeSemanticTokensToMonaco(result)) : null
    },
  }))
}

export function registerInlayHintsProvider(req: InlayHintsProviderRequest) {
  return register(req, "registerInlayHintsProvider", (token) => ({
    provideInlayHints: async (
      model: MonacoProviderModel,
      range: MonacoRange,
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<{ hints: VscodeInlayHint[] } | null>(
        req,
        "provideInlayHints",
        { ...documentPayload(token, model), range: monacoRangeToVscode(range) },
        cancellation
      )
      return result ? toMonacoInlayHints(result.hints.map(vscodeInlayHintToMonaco)) : null
    },
  }))
}

/**
 * Inert in standalone Monaco, which has no call-hierarchy view: the
 * registration returns `supported: false` (see {@link register}). The
 * provider object is still built so a Monaco build that adds the API gets
 * a working one.
 */
export function registerCallHierarchyProvider(req: CallHierarchyProviderRequest) {
  return register(req, "registerCallHierarchyProvider", (token) => ({
    prepareCallHierarchy: (model: MonacoProviderModel, position: MonacoPosition) =>
      call<MonacoUnknownArray | null>(req, "prepareCallHierarchy", {
        ...documentPayload(token, model),
        position: monacoPositionToVscode(position),
      }),
    provideIncomingCalls: (item: unknown) =>
      call<MonacoUnknownArray | null>(req, "provideIncomingCalls", { token, item }),
    provideOutgoingCalls: (item: unknown) =>
      call<MonacoUnknownArray | null>(req, "provideOutgoingCalls", { token, item }),
  }))
}

/** Inert in standalone Monaco, like {@link registerCallHierarchyProvider}. */
export function registerTypeHierarchyProvider(req: TypeHierarchyProviderRequest) {
  return register(req, "registerTypeHierarchyProvider", (token) => ({
    prepareTypeHierarchy: (model: MonacoProviderModel, position: MonacoPosition) =>
      call<MonacoUnknownArray | null>(req, "prepareTypeHierarchy", {
        ...documentPayload(token, model),
        position: monacoPositionToVscode(position),
      }),
    provideSupertypes: (item: unknown) =>
      call<MonacoUnknownArray | null>(req, "provideSupertypes", { token, item }),
    provideSubtypes: (item: unknown) =>
      call<MonacoUnknownArray | null>(req, "provideSubtypes", { token, item }),
  }))
}

export function registerLinkedEditingRangeProvider(req: LinkedEditingRangeProviderRequest) {
  return register(req, "registerLinkedEditingRangeProvider", (token) => ({
    provideLinkedEditingRanges: async (
      model: MonacoProviderModel,
      position: MonacoPosition,
      cancellation?: MonacoCancellationToken
    ) => {
      const result = await call<{ ranges: AdapterVscodeRange[]; wordPattern?: string } | null>(
        req,
        "provideLinkedEditingRanges",
        { ...documentPayload(token, model), position: monacoPositionToVscode(position) },
        cancellation
      )
      return result
        ? {
            ranges: result.ranges.map(vscodeRangeToMonaco),
            ...(result.wordPattern ? { wordPattern: new RegExp(result.wordPattern) } : {}),
          }
        : null
    },
  }))
}

/**
 * Push a diagnostic collection to Monaco's marker store.
 * Used by `vscode.languages.createDiagnosticCollection().set(uri, diagnostics)`.
 */
export function setDiagnostics(req: {
  extensionId: string
  uri: string
  markers: MonacoMarker[]
}): void {
  assertConfigured()
  // Kept per URI and owner: diagnostics usually arrive for files nobody has
  // open yet, and they must show when the file opens.
  let byOwner = diagnostics.get(req.uri)
  if (req.markers.length > 0) {
    if (!byOwner) diagnostics.set(req.uri, (byOwner = new Map()))
    byOwner.set(req.extensionId, req.markers)
  } else if (byOwner) {
    byOwner.delete(req.extensionId)
    if (byOwner.size === 0) diagnostics.delete(req.uri)
  }
  monacoApi!.editor.setModelMarkers(req.uri, req.extensionId, req.markers)
}

/** The markers each owner has set on `uri`, for tests and diagnostics views. */
export function getDiagnostics(uri: string): Array<{ owner: string; markers: MonacoMarker[] }> {
  return [...(diagnostics.get(uri) ?? new Map<string, MonacoMarker[]>())].map(
    ([owner, markers]) => ({ owner, markers })
  )
}

function applyStoredDiagnostics(uri: string): void {
  if (!monacoApi) return
  for (const [owner, markers] of diagnostics.get(uri) ?? []) {
    monacoApi.editor.setModelMarkers(uri, owner, markers)
  }
}

/**
 * Register a decoration type. VS Code's
 * `window.createTextEditorDecorationType(options)` returns a type id that
 * the extension then uses with `editor.setDecorations(type, ranges)`.
 */
export function registerDecorationType(req: {
  extensionId: string
  options: MonacoDecorationOptions
}): { typeId: string; dispose(): void } {
  const typeId = nanoid()
  decorationTypes.set(typeId, { extensionId: req.extensionId, className: req.options.className })
  return {
    typeId,
    dispose: () => {
      decorationTypes.delete(typeId)
    },
  }
}

/**
 * Apply previously registered decorations to a model. The sidecar calls
 * this when an extension invokes `editor.setDecorations(type, ranges)`.
 */
export function setDecorations(req: {
  editorId: string
  typeId: string
  decorations: MonacoDecoration[]
}): void {
  const editor = editors.get(req.editorId)
  if (!editor) return
  editor.setDecorations(req.typeId, req.decorations)
}

/** `{$regexp, flags}` (how a `RegExp` crosses JSON) back into a `RegExp`. */
export function reviveRegExps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveRegExps)
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    if (typeof record.$regexp === "string") {
      return new RegExp(record.$regexp, typeof record.flags === "string" ? record.flags : "")
    }
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [key, reviveRegExps(entry)])
    )
  }
  return value
}

/**
 * `vscode.languages.setLanguageConfiguration`. Replacing a handle disposes
 * its previous configuration; Monaco merges every live one for a language.
 */
export function setLanguageConfiguration(req: {
  extensionId: string
  handle: string
  language: string
  configuration: unknown
}): void {
  assertConfigured()
  if (!monacoApi!.setLanguageConfiguration) return
  disposeLanguageConfiguration(req.handle)
  const disposable = monacoApi!.setLanguageConfiguration(
    req.language,
    reviveRegExps(req.configuration)
  )
  languageConfigurations.set(req.handle, { extensionId: req.extensionId, disposable })
}

export function disposeLanguageConfiguration(handle: string): boolean {
  const entry = languageConfigurations.get(handle)
  if (!entry) return false
  languageConfigurations.delete(handle)
  try {
    entry.disposable.dispose()
  } catch (err) {
    console.warn(`monaco-bridge: language configuration ${handle} threw on dispose:`, err)
  }
  return true
}

/**
 * `vscode.languages.setTextDocumentLanguage`: switch the model's language
 * and tell everything tracking its editors (the document sync reports it to
 * every extension host as a close and reopen).
 */
export function setDocumentLanguage(uri: string, languageId: string): boolean {
  assertConfigured()
  if (!monacoApi!.setModelLanguage?.(uri, languageId)) return false
  for (const editor of editors.values()) {
    if (editor.getModel()?.uri === uri) {
      fireEditorChange({ editorId: editor.id, uri, kind: "change-language" })
    }
  }
  return true
}

export function unregisterByToken(token: string): boolean {
  const record = registrations.get(token)
  if (!record) return false
  try {
    record.disposable.dispose()
  } catch (err) {
    console.warn(`monaco-bridge: disposable threw for token ${token}:`, err)
  }
  registrations.delete(token)
  return true
}

/**
 * Bulk-cleanup when an extension deactivates. Returns the count of
 * provider registrations that were torn down.
 */
export function unregisterByExtension(extensionId: string): number {
  let removed = 0
  for (const [token, record] of registrations) {
    if (record.extensionId === extensionId) {
      try {
        record.disposable.dispose()
      } catch (err) {
        console.warn(`monaco-bridge: disposable threw during extension cleanup:`, err)
      }
      registrations.delete(token)
      removed += 1
    }
  }
  for (const [id, deco] of decorationTypes) {
    if (deco.extensionId === extensionId) {
      decorationTypes.delete(id)
    }
  }
  for (const [token, provider] of workspaceSymbolProviders) {
    if (provider.extensionId === extensionId) {
      workspaceSymbolProviders.delete(token)
    }
  }
  for (const [handle, entry] of [...languageConfigurations]) {
    if (entry.extensionId === extensionId) disposeLanguageConfiguration(handle)
  }
  for (const [uri, byOwner] of [...diagnostics]) {
    if (!byOwner.has(extensionId)) continue
    byOwner.delete(extensionId)
    if (byOwner.size === 0) diagnostics.delete(uri)
    monacoApi?.editor.setModelMarkers(uri, extensionId, [])
  }
  return removed
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function assertConfigured(): void {
  if (!monacoApi || !dispatchRpc) {
    throw new Error(
      "monaco-bridge not configured. Call configureMonacoBridge() before registering providers."
    )
  }
}

function registerToken(
  token: string,
  extensionId: string,
  disposable: Disposable,
  supported: boolean
): ProviderRegistration {
  registrations.set(token, { token, extensionId, disposable })
  return {
    token,
    supported,
    dispose: () => {
      unregisterByToken(token)
    },
  }
}

function fireActiveEditorChanged(editor: MonacoEditor | null): void {
  queueMicrotask(() => {
    for (const listener of activeEditorListeners) {
      try {
        listener(editor)
      } catch (err) {
        console.warn("monaco-bridge: active editor listener threw:", err)
      }
    }
  })
}

function fireEditorChange(event: MonacoEditorChangeEvent): void {
  queueMicrotask(() => {
    for (const listener of editorChangeListeners) {
      try {
        listener(event)
      } catch (err) {
        console.warn("monaco-bridge: editor change listener threw:", err)
      }
    }
  })
}

export function __resetMonacoBridgeForTesting(): void {
  monacoApi = null
  dispatchRpc = null
  editors.clear()
  activeEditorId = null
  registrations.clear()
  diagnostics.clear()
  languageConfigurations.clear()
  decorationTypes.clear()
  workspaceSymbolProviders.clear()
  activeEditorListeners.clear()
  editorChangeListeners.clear()
}
