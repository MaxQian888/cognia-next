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
  vscodeTextEditsToMonaco,
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
} from "./lsp-protocol-adapter"

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
}

export interface MonacoEditor {
  /** Stable opaque id for matching active/notifications. */
  id: string
  getModel(): MonacoTextModel | null
  getPosition(): MonacoPosition | null
  getSelection(): MonacoRange | null
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
  /** Document selector: list of language ids. `["*"]` matches all. */
  selector: string[]
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
  payload: unknown
) => Promise<T>

export interface MonacoApi {
  languages: {
    registerCompletionItemProvider(
      languageSelector: string | string[],
      provider: {
        triggerCharacters?: string[]
        provideCompletionItems: (
          model: MonacoTextModel,
          position: MonacoPosition
        ) => Promise<{ suggestions: MonacoCompletionItem[] } | null | undefined>
      }
    ): Disposable
    registerHoverProvider(
      languageSelector: string | string[],
      provider: {
        provideHover: (
          model: MonacoTextModel,
          position: MonacoPosition
        ) => Promise<MonacoHover | null | undefined>
      }
    ): Disposable
    registerDefinitionProvider(
      languageSelector: string | string[],
      provider: {
        provideDefinition: (
          model: MonacoTextModel,
          position: MonacoPosition
        ) => Promise<MonacoLocation[] | null | undefined>
      }
    ): Disposable
    registerReferenceProvider(
      languageSelector: string | string[],
      provider: {
        provideReferences: (
          model: MonacoTextModel,
          position: MonacoPosition
        ) => Promise<MonacoLocation[] | null | undefined>
      }
    ): Disposable
    registerDocumentFormattingEditProvider(
      languageSelector: string | string[],
      provider: {
        provideDocumentFormattingEdits: (
          model: MonacoTextModel
        ) => Promise<MonacoTextEdit[] | null | undefined>
      }
    ): Disposable
    registerDocumentRangeFormattingEditProvider(
      languageSelector: string | string[],
      provider: {
        provideDocumentRangeFormattingEdits: (
          model: MonacoTextModel,
          range: MonacoRange
        ) => Promise<MonacoTextEdit[] | null | undefined>
      }
    ): Disposable
    registerCodeLensProvider(
      languageSelector: string | string[],
      provider: {
        provideCodeLenses: (model: MonacoTextModel) => Promise<MonacoCodeLens[] | null | undefined>
      }
    ): Disposable
    registerCodeActionProvider(
      languageSelector: string | string[],
      provider: {
        provideCodeActions: (
          model: MonacoTextModel,
          range: MonacoRange
        ) => Promise<MonacoCodeLens[] | null | undefined>
      }
    ): Disposable
    registerRenameProvider(
      languageSelector: string | string[],
      provider: {
        provideRenameEdits: (
          model: MonacoTextModel,
          position: MonacoPosition,
          newName: string
        ) => Promise<MonacoTextEdit[] | null | undefined>
      }
    ): Disposable
    registerDocumentSymbolProvider(
      languageSelector: string | string[],
      provider: {
        provideDocumentSymbols: (model: MonacoTextModel) => Promise<unknown[] | null | undefined>
      }
    ): Disposable
    registerInlineCompletionsProvider(
      languageSelector: string | string[],
      provider: {
        triggerCharacters?: string[]
        provideInlineCompletions: (
          model: MonacoTextModel,
          position: MonacoPosition
        ) => Promise<{ items: MonacoUnknownArray } | null | undefined>
        freeInlineCompletions?(value: unknown): void
      }
    ): Disposable
    registerSignatureHelpProvider(
      languageSelector: string | string[],
      provider: {
        signatureHelpTriggerCharacters?: string[]
        signatureHelpRetriggerCharacters?: string[]
        provideSignatureHelp: (
          model: MonacoTextModel,
          position: MonacoPosition
        ) => Promise<{ value: MonacoSignatureHelp } | null | undefined>
      }
    ): Disposable
    registerColorProvider(
      languageSelector: string | string[],
      provider: {
        provideDocumentColors: (
          model: MonacoTextModel
        ) => Promise<MonacoColorInformation[] | null | undefined>
        provideColorPresentations: (
          model: MonacoTextModel,
          colorInfo: MonacoColorInformation
        ) => Promise<MonacoUnknownArray | null | undefined>
      }
    ): Disposable
    registerFoldingRangeProvider(
      languageSelector: string | string[],
      provider: {
        provideFoldingRanges: (
          model: MonacoTextModel
        ) => Promise<MonacoFoldingRange[] | null | undefined>
      }
    ): Disposable
    registerSelectionRangeProvider(
      languageSelector: string | string[],
      provider: {
        provideSelectionRanges: (
          model: MonacoTextModel,
          positions: MonacoPosition[]
        ) => Promise<MonacoSelectionRange[][] | null | undefined>
      }
    ): Disposable
    registerLinkProvider(
      languageSelector: string | string[],
      provider: {
        provideLinks: (
          model: MonacoTextModel
        ) => Promise<{ links: MonacoDocumentLink[] } | null | undefined>
      }
    ): Disposable
    registerOnTypeFormattingEditProvider(
      languageSelector: string | string[],
      provider: {
        autoFormatTriggerCharacters: string[]
        provideOnTypeFormattingEdits: (
          model: MonacoTextModel,
          position: MonacoPosition,
          ch: string
        ) => Promise<MonacoTextEdit[] | null | undefined>
      }
    ): Disposable
    registerDocumentSemanticTokensProvider(
      languageSelector: string | string[],
      provider: {
        getLegend(): { tokenTypes: string[]; tokenModifiers: string[] }
        provideDocumentSemanticTokens: (
          model: MonacoTextModel
        ) => Promise<MonacoSemanticTokens | null | undefined>
        releaseDocumentSemanticTokens?(resultId: string | undefined): void
      }
    ): Disposable
    registerDocumentRangeSemanticTokensProvider(
      languageSelector: string | string[],
      provider: {
        getLegend(): { tokenTypes: string[]; tokenModifiers: string[] }
        provideDocumentRangeSemanticTokens: (
          model: MonacoTextModel,
          range: MonacoRange
        ) => Promise<MonacoSemanticTokens | null | undefined>
      }
    ): Disposable
    registerInlayHintsProvider(
      languageSelector: string | string[],
      provider: {
        provideInlayHints: (
          model: MonacoTextModel,
          range: MonacoRange
        ) => Promise<{ hints: MonacoInlayHint[] } | null | undefined>
      }
    ): Disposable
    registerCallHierarchyProvider(
      languageSelector: string | string[],
      provider: {
        prepareCallHierarchy: (
          model: MonacoTextModel,
          position: MonacoPosition
        ) => Promise<MonacoUnknownArray | null | undefined>
        provideIncomingCalls: (item: unknown) => Promise<MonacoUnknownArray | null | undefined>
        provideOutgoingCalls: (item: unknown) => Promise<MonacoUnknownArray | null | undefined>
      }
    ): Disposable
    registerTypeHierarchyProvider(
      languageSelector: string | string[],
      provider: {
        prepareTypeHierarchy: (
          model: MonacoTextModel,
          position: MonacoPosition
        ) => Promise<MonacoUnknownArray | null | undefined>
        provideSupertypes: (item: unknown) => Promise<MonacoUnknownArray | null | undefined>
        provideSubtypes: (item: unknown) => Promise<MonacoUnknownArray | null | undefined>
      }
    ): Disposable
    registerLinkedEditingRangeProvider(
      languageSelector: string | string[],
      provider: {
        provideLinkedEditingRanges: (
          model: MonacoTextModel,
          position: MonacoPosition
        ) => Promise<{ ranges: MonacoRange[] } | null | undefined>
      }
    ): Disposable
  }
  editor: {
    setModelMarkers(model: MonacoTextModel, owner: string, markers: MonacoMarker[]): void
  }
}

export interface Disposable {
  dispose(): void
}

// ────────────────────────────────────────────────────────────────────────
// Internal state
// ────────────────────────────────────────────────────────────────────────

let monacoApi: MonacoApi | null = null
let dispatchRpc: DispatchRpc | null = null

const editors = new Map<string, MonacoEditor>()
let activeEditorId: string | null = null

interface RegistrationRecord {
  extensionId: string
  disposable: Disposable
  /** Token cognia gives the sidecar so it can call `unregister(token)`. */
  token: string
}

const registrations = new Map<string, RegistrationRecord>()
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
  kind: "open" | "close" | "change-selection" | "change-content"
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
 * Called by Skills / Canvas / Artifact when a Monaco editor mounts. The
 * bridge becomes aware of the editor; the sidecar can subsequently use
 * the editor's URI as `vscode.window.activeTextEditor`.
 */
export function notifyEditorMounted(editor: MonacoEditor): void {
  editors.set(editor.id, editor)
  const model = editor.getModel()
  if (model) {
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
// Provider registrations — every helper below routes the provider
// invocation back to the sidecar via `dispatchRpc`.
// ────────────────────────────────────────────────────────────────────────

export function registerCompletionItemProvider(req: CompletionProviderRequest): {
  token: string
  dispose(): void
} {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerCompletionItemProvider(req.selector, {
    triggerCharacters: req.triggerCharacters,
    provideCompletionItems: async (model, position) => {
      const result = await dispatchRpc!<VscodeCompletionResult | null>(
        req.extensionId,
        "provideCompletionItems",
        { token, uri: model.uri, position: monacoPositionToVscode(position) }
      )
      return vscodeCompletionResultToMonaco(result)
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerHoverProvider(req: HoverProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerHoverProvider(req.selector, {
    provideHover: async (model, position) => {
      const result = await dispatchRpc!<VscodeHover | null>(req.extensionId, "provideHover", {
        token,
        uri: model.uri,
        position: monacoPositionToVscode(position),
      })
      return result ? vscodeHoverToMonaco(result) : null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerDefinitionProvider(req: DefinitionProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerDefinitionProvider(req.selector, {
    provideDefinition: async (model, position) => {
      const result = await dispatchRpc!<VscodeLocation[] | VscodeLocation | null>(
        req.extensionId,
        "provideDefinition",
        { token, uri: model.uri, position: monacoPositionToVscode(position) }
      )
      if (result == null) return null
      const locs = Array.isArray(result) ? result : [result]
      return vscodeLocationsToMonaco(locs)
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerReferenceProvider(req: ReferenceProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerReferenceProvider(req.selector, {
    provideReferences: async (model, position) => {
      const result = await dispatchRpc!<VscodeLocation[] | null>(
        req.extensionId,
        "provideReferences",
        { token, uri: model.uri, position: monacoPositionToVscode(position) }
      )
      return result ? vscodeLocationsToMonaco(result) : null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerDocumentFormattingProvider(req: FormattingProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerDocumentFormattingEditProvider(req.selector, {
    provideDocumentFormattingEdits: async (model) => {
      const result = await dispatchRpc!<VscodeTextEdit[] | null>(
        req.extensionId,
        "provideDocumentFormattingEdits",
        { token, uri: model.uri }
      )
      return result ? vscodeTextEditsToMonaco(result) : null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerDocumentRangeFormattingProvider(req: RangeFormattingProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerDocumentRangeFormattingEditProvider(
    req.selector,
    {
      provideDocumentRangeFormattingEdits: async (model, range) => {
        const result = await dispatchRpc!<VscodeTextEdit[] | null>(
          req.extensionId,
          "provideDocumentRangeFormattingEdits",
          { token, uri: model.uri, range: monacoRangeToVscode(range) }
        )
        return result ? vscodeTextEditsToMonaco(result) : null
      },
    }
  )
  return registerToken(token, req.extensionId, disposable)
}

export function registerCodeLensProvider(req: CodeLensProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerCodeLensProvider(req.selector, {
    provideCodeLenses: async (model) => {
      const result = await dispatchRpc!<VscodeCodeLens[] | null>(
        req.extensionId,
        "provideCodeLenses",
        { token, uri: model.uri }
      )
      return result ? result.map(vscodeCodeLensToMonaco) : null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerCodeActionsProvider(req: CodeActionsProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerCodeActionProvider(req.selector, {
    provideCodeActions: async (model, range) => {
      // CodeActions ride through with their VS Code shape — Monaco accepts
      // any object with `title`/`kind`/`command`/`edit`. We only convert
      // ranges inside the action's edits if present; for now pass-through.
      const result = await dispatchRpc!<MonacoCodeLens[] | null>(
        req.extensionId,
        "provideCodeActions",
        { token, uri: model.uri, range: monacoRangeToVscode(range) }
      )
      return result ?? null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerRenameProvider(req: RenameProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerRenameProvider(req.selector, {
    provideRenameEdits: async (model, position, newName) => {
      const result = await dispatchRpc!<VscodeTextEdit[] | null>(
        req.extensionId,
        "provideRenameEdits",
        {
          token,
          uri: model.uri,
          position: monacoPositionToVscode(position),
          newName,
        }
      )
      return result ? vscodeTextEditsToMonaco(result) : null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerDocumentSymbolProvider(req: DocumentSymbolProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerDocumentSymbolProvider(req.selector, {
    provideDocumentSymbols: async (model) => {
      const result = await dispatchRpc!<VscodeDocumentSymbol[] | null>(
        req.extensionId,
        "provideDocumentSymbols",
        { token, uri: model.uri }
      )
      return result ? result.map(vscodeDocumentSymbolToMonaco) : null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

// ────────────────────────────────────────────────────────────────────────
// Phase B additions — 10 previously-stranded providers + 4 brand-new ones.
// Every one mirrors the established shape: register through Monaco's
// `languages.*`, route invocations back through `dispatchRpc`.
// ────────────────────────────────────────────────────────────────────────

export function registerInlineCompletionProvider(req: InlineCompletionProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerInlineCompletionsProvider(req.selector, {
    triggerCharacters: req.triggerCharacters,
    provideInlineCompletions: async (model, position) => {
      const result = await dispatchRpc!<VscodeInlineCompletionResult | null>(
        req.extensionId,
        "provideInlineCompletionItems",
        { token, uri: model.uri, position: monacoPositionToVscode(position) }
      )
      return vscodeInlineCompletionResultToMonaco(result)
    },
    freeInlineCompletions: () => {
      // No-op: cognia doesn't pool inline completion result objects.
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerSignatureHelpProvider(req: SignatureHelpProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerSignatureHelpProvider(req.selector, {
    signatureHelpTriggerCharacters: req.triggerCharacters,
    signatureHelpRetriggerCharacters: req.retriggerCharacters,
    provideSignatureHelp: async (model, position) => {
      const result = await dispatchRpc!<VscodeSignatureHelp | null>(
        req.extensionId,
        "provideSignatureHelp",
        { token, uri: model.uri, position: monacoPositionToVscode(position) }
      )
      return result ? { value: vscodeSignatureHelpToMonaco(result) } : null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

/**
 * Workspace symbol search has no direct Monaco equivalent — Monaco
 * registers per-model providers, not cross-workspace search. We surface
 * the provider via the command registry instead: the sidecar's
 * `WorkspaceSymbolProvider` becomes a callable command
 * `<extensionId>:workspaceSymbol(query)` that any cognia UI (command
 * palette, quick-open) can invoke.
 */
export function registerWorkspaceSymbolProvider(req: WorkspaceSymbolProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable: Disposable = {
    dispose() {
      workspaceSymbolProviders.delete(token)
    },
  }
  workspaceSymbolProviders.set(token, {
    extensionId: req.extensionId,
    invoke: (query) =>
      dispatchRpc!<unknown[] | null>(req.extensionId, "provideWorkspaceSymbols", { token, query }),
  })
  return registerToken(token, req.extensionId, disposable)
}

/**
 * Public helper for cognia UI surfaces (command palette, sidebar search)
 * to query every registered workspace symbol provider.
 */
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
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerColorProvider(req.selector, {
    provideDocumentColors: async (model) => {
      const result = await dispatchRpc!<VscodeColorInformation[] | null>(
        req.extensionId,
        "provideDocumentColors",
        { token, uri: model.uri }
      )
      return result ? result.map(vscodeColorInformationToMonaco) : null
    },
    provideColorPresentations: async (model, colorInfo) => {
      // colorInfo flows back to the sidecar with its range in VSCode shape.
      const vscodeColorInfo = {
        range: monacoRangeToVscode(colorInfo.range),
        color: colorInfo.color,
      }
      const result = await dispatchRpc!<MonacoUnknownArray | null>(
        req.extensionId,
        "provideColorPresentations",
        { token, uri: model.uri, colorInfo: vscodeColorInfo }
      )
      return result ?? null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerFoldingRangeProvider(req: FoldingRangeProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerFoldingRangeProvider(req.selector, {
    provideFoldingRanges: async (model) => {
      const result = await dispatchRpc!<VscodeFoldingRange[] | null>(
        req.extensionId,
        "provideFoldingRanges",
        { token, uri: model.uri }
      )
      return result ? result.map(vscodeFoldingRangeToMonaco) : null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerSelectionRangeProvider(req: SelectionRangeProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerSelectionRangeProvider(req.selector, {
    provideSelectionRanges: async (model, positions) => {
      const result = await dispatchRpc!<VscodeSelectionRange[][] | null>(
        req.extensionId,
        "provideSelectionRanges",
        {
          token,
          uri: model.uri,
          positions: positions.map(monacoPositionToVscode),
        }
      )
      return result ? result.map((perPos) => perPos.map(vscodeSelectionRangeToMonaco)) : null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerDocumentLinkProvider(req: DocumentLinkProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerLinkProvider(req.selector, {
    provideLinks: async (model) => {
      const result = await dispatchRpc!<{ links: VscodeDocumentLink[] } | null>(
        req.extensionId,
        "provideDocumentLinks",
        { token, uri: model.uri }
      )
      return result ? { links: result.links.map(vscodeDocumentLinkToMonaco) } : null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerOnTypeFormattingProvider(req: OnTypeFormattingProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerOnTypeFormattingEditProvider(req.selector, {
    autoFormatTriggerCharacters: [req.firstTriggerCharacter, ...(req.moreTriggerCharacter ?? [])],
    provideOnTypeFormattingEdits: async (model, position, ch) => {
      const result = await dispatchRpc!<VscodeTextEdit[] | null>(
        req.extensionId,
        "provideOnTypeFormattingEdits",
        { token, uri: model.uri, position: monacoPositionToVscode(position), ch }
      )
      return result ? vscodeTextEditsToMonaco(result) : null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerDocumentSemanticTokensProvider(req: SemanticTokensProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerDocumentSemanticTokensProvider(req.selector, {
    getLegend: () => req.legend,
    provideDocumentSemanticTokens: async (model) => {
      const result = await dispatchRpc!<VscodeSemanticTokens | null>(
        req.extensionId,
        "provideDocumentSemanticTokens",
        { token, uri: model.uri }
      )
      return result ? vscodeSemanticTokensToMonaco(result) : null
    },
    releaseDocumentSemanticTokens: () => {
      // Sidecar manages its own cache keyed by resultId.
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerDocumentRangeSemanticTokensProvider(req: SemanticTokensProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerDocumentRangeSemanticTokensProvider(
    req.selector,
    {
      getLegend: () => req.legend,
      provideDocumentRangeSemanticTokens: async (model, range) => {
        const result = await dispatchRpc!<VscodeSemanticTokens | null>(
          req.extensionId,
          "provideDocumentRangeSemanticTokens",
          { token, uri: model.uri, range: monacoRangeToVscode(range) }
        )
        return result ? vscodeSemanticTokensToMonaco(result) : null
      },
    }
  )
  return registerToken(token, req.extensionId, disposable)
}

export function registerInlayHintsProvider(req: InlayHintsProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerInlayHintsProvider(req.selector, {
    provideInlayHints: async (model, range) => {
      const result = await dispatchRpc!<{ hints: VscodeInlayHint[] } | null>(
        req.extensionId,
        "provideInlayHints",
        { token, uri: model.uri, range: monacoRangeToVscode(range) }
      )
      return result ? { hints: result.hints.map(vscodeInlayHintToMonaco) } : null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerCallHierarchyProvider(req: CallHierarchyProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerCallHierarchyProvider(req.selector, {
    prepareCallHierarchy: async (model, position) => {
      const result = await dispatchRpc!<MonacoUnknownArray | null>(
        req.extensionId,
        "prepareCallHierarchy",
        { token, uri: model.uri, position: monacoPositionToVscode(position) }
      )
      return result ?? null
    },
    provideIncomingCalls: async (item) => {
      const result = await dispatchRpc!<MonacoUnknownArray | null>(
        req.extensionId,
        "provideIncomingCalls",
        { token, item }
      )
      return result ?? null
    },
    provideOutgoingCalls: async (item) => {
      const result = await dispatchRpc!<MonacoUnknownArray | null>(
        req.extensionId,
        "provideOutgoingCalls",
        { token, item }
      )
      return result ?? null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerTypeHierarchyProvider(req: TypeHierarchyProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerTypeHierarchyProvider(req.selector, {
    prepareTypeHierarchy: async (model, position) => {
      const result = await dispatchRpc!<MonacoUnknownArray | null>(
        req.extensionId,
        "prepareTypeHierarchy",
        { token, uri: model.uri, position: monacoPositionToVscode(position) }
      )
      return result ?? null
    },
    provideSupertypes: async (item) => {
      const result = await dispatchRpc!<MonacoUnknownArray | null>(
        req.extensionId,
        "provideSupertypes",
        { token, item }
      )
      return result ?? null
    },
    provideSubtypes: async (item) => {
      const result = await dispatchRpc!<MonacoUnknownArray | null>(
        req.extensionId,
        "provideSubtypes",
        { token, item }
      )
      return result ?? null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerLinkedEditingRangeProvider(req: LinkedEditingRangeProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerLinkedEditingRangeProvider(req.selector, {
    provideLinkedEditingRanges: async (model, position) => {
      const result = await dispatchRpc!<{ ranges: AdapterVscodeRange[] } | null>(
        req.extensionId,
        "provideLinkedEditingRanges",
        { token, uri: model.uri, position: monacoPositionToVscode(position) }
      )
      return result
        ? {
            ranges: result.ranges.map((r) => ({
              startLineNumber: r.start.line + 1,
              startColumn: r.start.character + 1,
              endLineNumber: r.end.line + 1,
              endColumn: r.end.character + 1,
            })),
          }
        : null
    },
  })
  return registerToken(token, req.extensionId, disposable)
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
  const editor = [...editors.values()].find((e) => e.getModel()?.uri === req.uri)
  const model = editor?.getModel()
  if (!model) return
  monacoApi!.editor.setModelMarkers(model, req.extensionId, req.markers)
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
  disposable: Disposable
): { token: string; dispose(): void } {
  registrations.set(token, { token, extensionId, disposable })
  return {
    token,
    dispose: () => unregisterByToken(token),
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
  decorationTypes.clear()
  workspaceSymbolProviders.clear()
  activeEditorListeners.clear()
  editorChangeListeners.clear()
}
