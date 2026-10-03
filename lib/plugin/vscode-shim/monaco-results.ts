/**
 * The last step from a provider's answer to what Monaco accepts.
 *
 * `lsp-protocol-adapter` converts VS Code / LSP shapes into 1-based,
 * Monaco-like ones, but Monaco itself is stricter: a location's `uri` must
 * be a `monaco.Uri`, list results carry `dispose`, enums are numbers, a
 * completion needs a range, a symbol needs `tags`, and semantic tokens are a
 * `Uint32Array`. Each function here takes the adapter's output and returns
 * the value a Monaco provider method may return. They are pure apart from
 * `parseUri`, so the bridge can be tested against them without Monaco.
 */

import type {
  MonacoDocumentLink,
  MonacoFoldingRange,
  MonacoHover,
  MonacoInlayHint,
  MonacoLocation,
  MonacoPosition,
  MonacoRange,
  MonacoSelectionRange,
  MonacoSemanticTokens,
  MonacoSignatureHelp,
  MonacoTextEdit,
} from "./monaco-bridge"
import {
  vscodeRangeToMonaco,
  vscodeTextEditsToMonaco,
  vscodeWorkspaceEditToMonaco,
  type MonacoDocumentSymbol,
  type MonacoWorkspaceEdit,
  type VscodeDiagnostic,
  type VscodeRange,
  type VscodeTextEdit,
  type VscodeWorkspaceEdit,
} from "./lsp-protocol-adapter"

/** What the finalizers need from Monaco: turning a URI string into a `monaco.Uri`. */
export interface MonacoRuntime {
  parseUri(uri: string): unknown
}

/** `monaco.languages.InlayHintKind`. */
export const MONACO_INLAY_HINT_KIND = { type: 1, parameter: 2 } as const
/** `monaco.MarkerSeverity`. */
export const MONACO_MARKER_SEVERITY = { hint: 1, info: 2, warning: 4, error: 8 } as const

const noop = () => {}

export function toMonacoHover(hover: MonacoHover): {
  contents: Array<{ value: string }>
  range?: MonacoRange
} {
  return {
    contents: hover.contents.map((value) => ({ value })),
    ...(hover.range ? { range: hover.range } : {}),
  }
}

export function toMonacoLocations(
  runtime: MonacoRuntime,
  locations: MonacoLocation[]
): Array<{ uri: unknown; range: MonacoRange }> {
  return locations.map((location) => ({
    uri: runtime.parseUri(location.uri),
    range: location.range,
  }))
}

export function toMonacoWorkspaceEdit(
  runtime: MonacoRuntime,
  edit: MonacoWorkspaceEdit
): {
  edits: Array<{ resource: unknown; textEdit: MonacoTextEdit; versionId: undefined }>
} {
  return {
    edits: edit.edits.flatMap((group) => {
      const resource = runtime.parseUri(group.resource)
      return group.edits.map((textEdit) => ({ resource, textEdit, versionId: undefined }))
    }),
  }
}

/**
 * A completion without a range replaces the word before the cursor, which
 * is what VS Code does; Monaco requires the range to be stated.
 */
export function toMonacoCompletions<T extends { range?: unknown }>(
  result: { suggestions: T[]; incomplete?: boolean },
  defaultRange: MonacoRange
): {
  suggestions: Array<T & { range: NonNullable<T["range"]> | MonacoRange }>
  incomplete?: boolean
} {
  return {
    ...result,
    suggestions: result.suggestions.map((item) => ({ ...item, range: item.range ?? defaultRange })),
  }
}

/** The word before `position`, from Monaco's `getWordUntilPosition`. */
export function wordRangeBefore(
  model: {
    getWordUntilPosition?(position: MonacoPosition): { startColumn: number; endColumn: number }
  },
  position: MonacoPosition
): MonacoRange {
  const word = model.getWordUntilPosition?.(position)
  return {
    startLineNumber: position.lineNumber,
    startColumn: word?.startColumn ?? position.column,
    endLineNumber: position.lineNumber,
    endColumn: word?.endColumn ?? position.column,
  }
}

export function toMonacoSignatureHelp(help: MonacoSignatureHelp): {
  value: MonacoSignatureHelp
  dispose(): void
} {
  return { value: help, dispose: noop }
}

export function toMonacoCodeLenses<T>(lenses: T[]): { lenses: T[]; dispose(): void } {
  return { lenses, dispose: noop }
}

export function toMonacoDocumentSymbols(
  symbols: MonacoDocumentSymbol[]
): Array<MonacoDocumentSymbol & { tags: number[] }> {
  return symbols.map((symbol) => ({
    ...symbol,
    tags: symbol.tags ?? [],
    children: symbol.children ? toMonacoDocumentSymbols(symbol.children) : undefined,
  }))
}

export function toMonacoInlayHints(hints: MonacoInlayHint[]): {
  hints: Array<{ label: string; position: MonacoPosition; kind?: number }>
  dispose(): void
} {
  return {
    hints: hints.map((hint) => ({
      label: hint.label,
      position: hint.position,
      ...(hint.kind ? { kind: MONACO_INLAY_HINT_KIND[hint.kind] } : {}),
    })),
    dispose: noop,
  }
}

export function toMonacoLinks(
  runtime: MonacoRuntime,
  links: MonacoDocumentLink[]
): { links: Array<{ range: MonacoRange; url?: unknown; tooltip?: string }> } {
  return {
    links: links.map((link) => ({
      range: link.range,
      ...(link.url ? { url: runtime.parseUri(link.url) } : {}),
      ...(link.tooltip ? { tooltip: link.tooltip } : {}),
    })),
  }
}

/** `FoldingRangeKind` is a class with a `value`; an object of that shape is accepted. */
export function toMonacoFoldingRanges(
  ranges: MonacoFoldingRange[]
): Array<{ start: number; end: number; kind?: { value: string } }> {
  return ranges.map((range) => ({
    start: range.start,
    end: range.end,
    ...(range.kind ? { kind: { value: range.kind } } : {}),
  }))
}

/** Monaco wants each position's ranges as a flat list, innermost first. */
export function toMonacoSelectionRanges(
  perPosition: MonacoSelectionRange[][]
): Array<Array<{ range: MonacoRange }>> {
  return perPosition.map((ranges) =>
    ranges.flatMap((range) => {
      const chain: Array<{ range: MonacoRange }> = []
      for (
        let current: MonacoSelectionRange | undefined = range;
        current;
        current = current.parent
      ) {
        chain.push({ range: current.range })
      }
      return chain
    })
  )
}

export function toMonacoSemanticTokens(tokens: MonacoSemanticTokens): {
  data: Uint32Array
  resultId?: string
} {
  return {
    data: Uint32Array.from(tokens.data),
    ...(tokens.resultId ? { resultId: tokens.resultId } : {}),
  }
}

/** LSP `ColorPresentation` → Monaco's. */
export function toMonacoColorPresentations(
  presentations: Array<{
    label: string
    textEdit?: VscodeTextEdit
    additionalTextEdits?: VscodeTextEdit[]
  }>
): Array<{ label: string; textEdit?: MonacoTextEdit; additionalTextEdits?: MonacoTextEdit[] }> {
  return presentations.map((presentation) => ({
    label: presentation.label,
    ...(presentation.textEdit
      ? { textEdit: vscodeTextEditsToMonaco([presentation.textEdit])[0] }
      : {}),
    ...(presentation.additionalTextEdits
      ? { additionalTextEdits: vscodeTextEditsToMonaco(presentation.additionalTextEdits) }
      : {}),
  }))
}

/** LSP `DocumentHighlight` (kind 1 text, 2 read, 3 write) → Monaco (0, 1, 2). */
export function toMonacoDocumentHighlights(
  highlights: Array<{ range: VscodeRange; kind?: number }>
): Array<{ range: MonacoRange; kind: number }> {
  return highlights.map((highlight) => ({
    range: vscodeRangeToMonaco(highlight.range),
    kind: highlight.kind ? highlight.kind - 1 : 0,
  }))
}

/** A wire command (`{command, title, arguments}`) → Monaco's `{id, title, arguments}`. */
function toMonacoCommand(command: { command: string; title: string; arguments?: unknown[] }) {
  return {
    id: command.command,
    title: command.title,
    ...(command.arguments ? { arguments: command.arguments } : {}),
  }
}

export interface WireCodeAction {
  title: string
  kind?: string
  isPreferred?: boolean
  disabled?: string | { reason: string }
  diagnostics?: VscodeDiagnostic[]
  edit?: VscodeWorkspaceEdit
  /** VS Code's `Command`, or a code action that is only a command. */
  command?: { command: string; title: string; arguments?: unknown[] } | string
  arguments?: unknown[]
}

/**
 * Code actions, as `CodeAction`s or bare `Command`s, → Monaco's
 * `CodeActionList`. Diagnostics are not echoed back: Monaco only uses them to
 * mark which markers an action fixes, and it matches them by identity.
 */
export function toMonacoCodeActions(
  runtime: MonacoRuntime,
  actions: WireCodeAction[]
): {
  actions: Array<{
    title: string
    kind?: string
    isPreferred?: boolean
    disabled?: string
    edit?: ReturnType<typeof toMonacoWorkspaceEdit>
    command?: { id: string; title: string; arguments?: unknown[] }
  }>
  dispose(): void
} {
  return {
    actions: actions.map((action) => {
      // A bare `Command` has `command` as its id string.
      if (typeof action.command === "string") {
        return {
          title: action.title,
          command: toMonacoCommand({
            command: action.command,
            title: action.title,
            arguments: action.arguments,
          }),
        }
      }
      return {
        title: action.title,
        ...(action.kind ? { kind: action.kind } : {}),
        ...(action.isPreferred ? { isPreferred: true } : {}),
        ...(action.disabled
          ? {
              disabled:
                typeof action.disabled === "string" ? action.disabled : action.disabled.reason,
            }
          : {}),
        ...(action.edit
          ? { edit: toMonacoWorkspaceEdit(runtime, vscodeWorkspaceEditToMonaco(action.edit)) }
          : {}),
        ...(action.command ? { command: toMonacoCommand(action.command) } : {}),
      }
    }),
    dispose: noop,
  }
}

/** Monaco markers (1-based, numeric severity) → VS Code diagnostics for a code-action context. */
export function monacoMarkersToVscodeDiagnostics(
  markers: Array<{
    severity: number
    message: string
    source?: string
    code?: string | { value: string; target: unknown }
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }>
): VscodeDiagnostic[] {
  return markers.map((marker) => ({
    range: {
      start: { line: marker.startLineNumber - 1, character: marker.startColumn - 1 },
      end: { line: marker.endLineNumber - 1, character: marker.endColumn - 1 },
    },
    severity:
      marker.severity >= MONACO_MARKER_SEVERITY.error
        ? 0
        : marker.severity >= MONACO_MARKER_SEVERITY.warning
          ? 1
          : marker.severity >= MONACO_MARKER_SEVERITY.info
            ? 2
            : 3,
    message: marker.message,
    ...(marker.source ? { source: marker.source } : {}),
    ...(marker.code === undefined
      ? {}
      : { code: typeof marker.code === "string" ? marker.code : marker.code.value }),
  }))
}

/** Bridge markers (string severity) → Monaco `IMarkerData`. */
export function toMonacoMarkers(
  markers: Array<{
    severity: keyof typeof MONACO_MARKER_SEVERITY
    message: string
    range: MonacoRange
    source?: string
  }>
): Array<{
  severity: number
  message: string
  source?: string
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}> {
  return markers.map((marker) => ({
    severity: MONACO_MARKER_SEVERITY[marker.severity] ?? MONACO_MARKER_SEVERITY.error,
    message: marker.message,
    ...(marker.source ? { source: marker.source } : {}),
    ...marker.range,
  }))
}
