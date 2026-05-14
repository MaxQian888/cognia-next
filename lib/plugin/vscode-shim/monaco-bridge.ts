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
  label: string
  kind?: string
  detail?: string
  documentation?: string
  insertText: string
  range?: MonacoRange
  filterText?: string
  sortText?: string
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
      const result = await dispatchRpc!<{ suggestions: MonacoCompletionItem[] } | null>(
        req.extensionId,
        "provideCompletionItems",
        { token, uri: model.uri, position }
      )
      return result ?? null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerHoverProvider(req: HoverProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerHoverProvider(req.selector, {
    provideHover: async (model, position) => {
      const result = await dispatchRpc!<MonacoHover | null>(req.extensionId, "provideHover", {
        token,
        uri: model.uri,
        position,
      })
      return result ?? null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerDefinitionProvider(req: DefinitionProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerDefinitionProvider(req.selector, {
    provideDefinition: async (model, position) => {
      const result = await dispatchRpc!<MonacoLocation[] | null>(
        req.extensionId,
        "provideDefinition",
        { token, uri: model.uri, position }
      )
      return result ?? null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerReferenceProvider(req: ReferenceProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerReferenceProvider(req.selector, {
    provideReferences: async (model, position) => {
      const result = await dispatchRpc!<MonacoLocation[] | null>(
        req.extensionId,
        "provideReferences",
        { token, uri: model.uri, position }
      )
      return result ?? null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerDocumentFormattingProvider(req: FormattingProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerDocumentFormattingEditProvider(req.selector, {
    provideDocumentFormattingEdits: async (model) => {
      const result = await dispatchRpc!<MonacoTextEdit[] | null>(
        req.extensionId,
        "provideDocumentFormattingEdits",
        { token, uri: model.uri }
      )
      return result ?? null
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
        const result = await dispatchRpc!<MonacoTextEdit[] | null>(
          req.extensionId,
          "provideDocumentRangeFormattingEdits",
          { token, uri: model.uri, range }
        )
        return result ?? null
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
      const result = await dispatchRpc!<MonacoCodeLens[] | null>(
        req.extensionId,
        "provideCodeLenses",
        { token, uri: model.uri }
      )
      return result ?? null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerCodeActionsProvider(req: CodeActionsProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerCodeActionProvider(req.selector, {
    provideCodeActions: async (model, range) => {
      const result = await dispatchRpc!<MonacoCodeLens[] | null>(
        req.extensionId,
        "provideCodeActions",
        { token, uri: model.uri, range }
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
      const result = await dispatchRpc!<MonacoTextEdit[] | null>(
        req.extensionId,
        "provideRenameEdits",
        { token, uri: model.uri, position, newName }
      )
      return result ?? null
    },
  })
  return registerToken(token, req.extensionId, disposable)
}

export function registerDocumentSymbolProvider(req: DocumentSymbolProviderRequest) {
  assertConfigured()
  const token = nanoid()
  const disposable = monacoApi!.languages.registerDocumentSymbolProvider(req.selector, {
    provideDocumentSymbols: async (model) => {
      const result = await dispatchRpc!<unknown[] | null>(
        req.extensionId,
        "provideDocumentSymbols",
        { token, uri: model.uri }
      )
      return result ?? null
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
  activeEditorListeners.clear()
  editorChangeListeners.clear()
}
