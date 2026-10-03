/**
 * Provider values ⇄ the renderer's wire shapes.
 *
 * Calls arrive with LSP-style arguments (0-based `{line, character}`
 * positions, ranges, contexts) and become VS Code objects before the
 * provider sees them. Answers go back in the shapes the renderer's
 * `lsp-protocol-adapter` reads, the ones a standalone language server's
 * answers already use: URIs as strings, Markdown as `{kind, value}`,
 * completion kinds 1-based (LSP), folding kinds as names, semantic tokens as
 * plain arrays. Symbol kinds stay 0-based (VS Code's, and Monaco's).
 *
 * Providers may return class instances or plain objects of the same shape,
 * so everything here reads fields rather than checking `instanceof`.
 */

import { CodeActionKind, Color, Diagnostic } from "./api-types"
import { Position, Range, type Uri } from "./types"

export interface WirePosition {
  line: number
  character: number
}

export interface WireRange {
  start: WirePosition
  end: WirePosition
}

type AnyRecord = Record<string, unknown>

// ── Arguments (renderer → provider) ─────────────────────────────────────

export function toPosition(wire: WirePosition): Position {
  return new Position(wire.line, wire.character)
}

export function toRange(wire: WireRange): Range {
  return new Range(toPosition(wire.start), toPosition(wire.end))
}

export function toColor(wire: { red: number; green: number; blue: number; alpha: number }): Color {
  return new Color(wire.red, wire.green, wire.blue, wire.alpha)
}

export function toDiagnostics(
  wire: Array<{
    range: WireRange
    message: string
    severity?: number
    source?: string
    code?: string | number
  }>
): Diagnostic[] {
  return wire.map((entry) => {
    const diagnostic = new Diagnostic(toRange(entry.range), entry.message, entry.severity ?? 0)
    if (entry.source) diagnostic.source = entry.source
    if (entry.code !== undefined) diagnostic.code = entry.code
    return diagnostic
  })
}

/** `only` arrives as the kind's string; providers compare `CodeActionKind`s. */
export function toCodeActionKind(value: string | undefined): CodeActionKind | undefined {
  return value === undefined ? undefined : CodeActionKind.Empty.append(value)
}

// ── Answers (provider → renderer) ───────────────────────────────────────

function isObject(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null
}

export function wirePosition(position: { line: number; character: number }): WirePosition {
  return { line: position.line, character: position.character }
}

export function wireRange(range: { start: WirePosition; end: WirePosition }): WireRange {
  return { start: wirePosition(range.start), end: wirePosition(range.end) }
}

export function wireUri(uri: Uri | string): string {
  return typeof uri === "string" ? uri : uri.toString()
}

type WireMarkup = string | { kind: "markdown"; value: string } | { language: string; value: string }

/** A `MarkdownString`, `MarkedString` or plain string. */
export function wireMarkup(value: unknown): WireMarkup | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  if (isObject(value) && typeof value.value === "string") {
    if (typeof value.language === "string") return { language: value.language, value: value.value }
    return { kind: "markdown", value: value.value }
  }
  return String(value)
}

function wireDocumentation(
  value: unknown
): string | { kind: "markdown"; value: string } | undefined {
  const markup = wireMarkup(value)
  if (markup === undefined || typeof markup === "string") return markup
  if ("language" in markup) {
    return { kind: "markdown", value: `\`\`\`${markup.language}\n${markup.value}\n\`\`\`` }
  }
  return markup
}

export function wireCommand(
  command: unknown
): { command: string; title: string; arguments?: unknown[] } | undefined {
  if (!isObject(command) || typeof command.command !== "string") return undefined
  return {
    command: command.command,
    title: typeof command.title === "string" ? command.title : "",
    ...(Array.isArray(command.arguments) ? { arguments: command.arguments } : {}),
  }
}

export function wireTextEdits(edits: unknown): Array<{ range: WireRange; newText: string }> {
  if (!Array.isArray(edits)) return []
  return edits
    .filter((edit): edit is AnyRecord => isObject(edit) && isObject(edit.range))
    .map((edit) => ({
      range: wireRange(edit.range as WireRange),
      newText: String(edit.newText ?? ""),
    }))
}

/** A `WorkspaceEdit`'s text edits, grouped by URI as LSP's `changes`. */
export function wireWorkspaceEdit(edit: unknown): {
  changes: Record<string, Array<{ range: WireRange; newText: string }>>
} {
  const changes: Record<string, Array<{ range: WireRange; newText: string }>> = {}
  if (isObject(edit) && typeof edit.entries === "function") {
    for (const [uri, edits] of (edit.entries as () => Array<[Uri, unknown]>).call(edit)) {
      changes[wireUri(uri)] = wireTextEdits(edits)
    }
  }
  return { changes }
}

/** `Location`, `Location[]` or `LocationLink[]` → LSP locations. */
export function wireLocations(result: unknown): Array<{ uri: string; range: WireRange }> | null {
  if (result === undefined || result === null) return null
  const items = Array.isArray(result) ? result : [result]
  const out: Array<{ uri: string; range: WireRange }> = []
  for (const item of items) {
    if (!isObject(item)) continue
    if (item.targetUri !== undefined) {
      const range = (item.targetSelectionRange ?? item.targetRange) as WireRange
      out.push({ uri: wireUri(item.targetUri as Uri), range: wireRange(range) })
    } else if (item.uri !== undefined && isObject(item.range)) {
      out.push({
        uri: wireUri(item.uri as Uri),
        range: wireRange(item.range as unknown as WireRange),
      })
    }
  }
  return out
}

function wireCompletionItem(item: AnyRecord) {
  const insert = item.insertText
  const snippet = isObject(insert) && typeof insert.value === "string"
  const range = item.range
  return {
    label: item.label as string | { label: string; detail?: string; description?: string },
    // VS Code's CompletionItemKind is 0-based; the wire carries LSP's 1-based one.
    ...(typeof item.kind === "number" ? { kind: item.kind + 1 } : {}),
    ...(Array.isArray(item.tags) ? { tags: item.tags as number[] } : {}),
    ...(typeof item.detail === "string" ? { detail: item.detail } : {}),
    ...(item.documentation !== undefined
      ? { documentation: wireDocumentation(item.documentation) }
      : {}),
    ...(insert !== undefined
      ? { insertText: snippet ? (insert as { value: string }).value : String(insert) }
      : {}),
    ...(snippet ? { insertTextFormat: 2 as const } : {}),
    ...(isObject(range)
      ? {
          range:
            "inserting" in range
              ? {
                  inserting: wireRange(range.inserting as WireRange),
                  replacing: wireRange(range.replacing as WireRange),
                }
              : wireRange(range as unknown as WireRange),
        }
      : {}),
    ...(typeof item.filterText === "string" ? { filterText: item.filterText } : {}),
    ...(typeof item.sortText === "string" ? { sortText: item.sortText } : {}),
    ...(item.preselect ? { preselect: true } : {}),
    ...(Array.isArray(item.commitCharacters)
      ? { commitCharacters: item.commitCharacters as string[] }
      : {}),
    ...(item.additionalTextEdits
      ? { additionalTextEdits: wireTextEdits(item.additionalTextEdits) }
      : {}),
    ...(item.command ? { command: wireCommand(item.command) } : {}),
  }
}

export function wireCompletions(result: unknown) {
  if (result === undefined || result === null) return null
  if (Array.isArray(result)) return result.filter(isObject).map(wireCompletionItem)
  if (isObject(result) && Array.isArray(result.items)) {
    return {
      isIncomplete: Boolean(result.isIncomplete),
      items: result.items.filter(isObject).map(wireCompletionItem),
    }
  }
  return null
}

export function wireHover(result: unknown) {
  if (!isObject(result)) return null
  const contents = Array.isArray(result.contents) ? result.contents : [result.contents]
  return {
    contents: contents.map(wireMarkup).filter((entry): entry is WireMarkup => entry !== undefined),
    ...(isObject(result.range) ? { range: wireRange(result.range as unknown as WireRange) } : {}),
  }
}

export function wireDocumentHighlights(result: unknown) {
  if (!Array.isArray(result)) return null
  // DocumentHighlightKind: VS Code Text 0 / Read 1 / Write 2; the wire is LSP's 1 / 2 / 3.
  return result.filter(isObject).map((highlight) => ({
    range: wireRange(highlight.range as WireRange),
    kind: (typeof highlight.kind === "number" ? highlight.kind : 0) + 1,
  }))
}

export function wireSignatureHelp(result: unknown) {
  if (!isObject(result) || !Array.isArray(result.signatures)) return null
  return {
    signatures: result.signatures.filter(isObject).map((signature) => ({
      label: String(signature.label),
      ...(signature.documentation !== undefined
        ? { documentation: wireDocumentation(signature.documentation) }
        : {}),
      parameters: (Array.isArray(signature.parameters) ? signature.parameters : [])
        .filter(isObject)
        .map((parameter) => ({
          label: parameter.label as string | [number, number],
          ...(parameter.documentation !== undefined
            ? { documentation: wireDocumentation(parameter.documentation) }
            : {}),
        })),
    })),
    activeSignature: typeof result.activeSignature === "number" ? result.activeSignature : 0,
    activeParameter: typeof result.activeParameter === "number" ? result.activeParameter : 0,
  }
}

function wireDiagnostics(diagnostics: unknown) {
  if (!Array.isArray(diagnostics)) return undefined
  return diagnostics.filter(isObject).map((diagnostic) => ({
    range: wireRange(diagnostic.range as WireRange),
    message: String(diagnostic.message ?? ""),
    severity: typeof diagnostic.severity === "number" ? diagnostic.severity : 0,
    ...(typeof diagnostic.source === "string" ? { source: diagnostic.source } : {}),
  }))
}

/** `CodeAction`s and bare `Command`s. A bare command carries its id as `command`. */
export function wireCodeActions(result: unknown) {
  if (!Array.isArray(result)) return null
  return result.filter(isObject).map((action) => {
    if (typeof action.command === "string") {
      return {
        title: String(action.title ?? ""),
        command: action.command,
        ...(Array.isArray(action.arguments) ? { arguments: action.arguments } : {}),
      }
    }
    const kind = action.kind
    return {
      title: String(action.title ?? ""),
      ...(isObject(kind) && typeof kind.value === "string"
        ? { kind: kind.value }
        : typeof kind === "string"
          ? { kind }
          : {}),
      ...(action.isPreferred ? { isPreferred: true } : {}),
      ...(isObject(action.disabled) && typeof action.disabled.reason === "string"
        ? { disabled: action.disabled.reason }
        : {}),
      ...(action.diagnostics ? { diagnostics: wireDiagnostics(action.diagnostics) } : {}),
      ...(action.edit ? { edit: wireWorkspaceEdit(action.edit) } : {}),
      ...(action.command ? { command: wireCommand(action.command) } : {}),
    }
  })
}

export function wireCodeLenses(lenses: unknown[]) {
  return lenses
    .filter((lens): lens is AnyRecord => isObject(lens) && isObject(lens.range))
    .map((lens) => ({
      range: wireRange(lens.range as WireRange),
      ...(lens.command ? { command: wireCommand(lens.command) } : {}),
    }))
}

interface WireDocumentSymbol {
  name: string
  detail: string
  kind: number
  range: WireRange
  selectionRange: WireRange
  children?: WireDocumentSymbol[]
  tags?: number[]
}

function wireDocumentSymbol(symbol: AnyRecord): WireDocumentSymbol {
  // A `SymbolInformation` has a location instead of ranges.
  const location = isObject(symbol.location) ? symbol.location : undefined
  const range = (location?.range ?? symbol.range) as WireRange
  return {
    name: String(symbol.name),
    detail: String(symbol.detail ?? symbol.containerName ?? ""),
    kind: typeof symbol.kind === "number" ? symbol.kind : 0,
    range: wireRange(range),
    selectionRange: wireRange((symbol.selectionRange ?? range) as WireRange),
    ...(Array.isArray(symbol.children) && symbol.children.length > 0
      ? { children: symbol.children.filter(isObject).map(wireDocumentSymbol) }
      : {}),
    ...(Array.isArray(symbol.tags) ? { tags: symbol.tags as number[] } : {}),
  }
}

export function wireDocumentSymbols(result: unknown) {
  if (!Array.isArray(result)) return null
  return result.filter(isObject).map(wireDocumentSymbol)
}

const EMPTY_RANGE: WireRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }

export function wireWorkspaceSymbols(result: unknown) {
  if (!Array.isArray(result)) return null
  return result
    .filter((symbol): symbol is AnyRecord => isObject(symbol) && isObject(symbol.location))
    .map((symbol) => {
      const location = symbol.location as AnyRecord
      return {
        name: String(symbol.name),
        kind: typeof symbol.kind === "number" ? symbol.kind : 0,
        containerName: String(symbol.containerName ?? ""),
        location: {
          uri: wireUri(location.uri as Uri),
          range: wireRange((location.range ?? EMPTY_RANGE) as WireRange),
        },
      }
    })
}

export function wireSemanticTokens(result: unknown) {
  if (!isObject(result) || result.data === undefined) return null
  return {
    ...(typeof result.resultId === "string" ? { resultId: result.resultId } : {}),
    data: Array.from(result.data as ArrayLike<number>),
  }
}

export function wireColors(result: unknown) {
  if (!Array.isArray(result)) return null
  return result.filter(isObject).map((info) => {
    const color = info.color as AnyRecord
    return {
      range: wireRange(info.range as WireRange),
      color: {
        red: Number(color.red),
        green: Number(color.green),
        blue: Number(color.blue),
        alpha: Number(color.alpha),
      },
    }
  })
}

export function wireColorPresentations(result: unknown) {
  if (!Array.isArray(result)) return null
  return result.filter(isObject).map((presentation) => ({
    label: String(presentation.label),
    ...(isObject(presentation.textEdit)
      ? { textEdit: wireTextEdits([presentation.textEdit])[0] }
      : {}),
    ...(presentation.additionalTextEdits
      ? { additionalTextEdits: wireTextEdits(presentation.additionalTextEdits) }
      : {}),
  }))
}

const FOLDING_KIND_NAMES: Record<number, string> = { 1: "comment", 2: "imports", 3: "region" }

export function wireFoldingRanges(result: unknown) {
  if (!Array.isArray(result)) return null
  return result.filter(isObject).map((range) => ({
    startLine: Number(range.start),
    endLine: Number(range.end),
    ...(typeof range.kind === "number" && FOLDING_KIND_NAMES[range.kind]
      ? { kind: FOLDING_KIND_NAMES[range.kind] }
      : {}),
  }))
}

/** One `SelectionRange` per position, its parent chain flattened innermost first. */
export function wireSelectionRanges(result: unknown) {
  if (!Array.isArray(result)) return null
  return result.map((selection) => {
    const chain: Array<{ range: WireRange }> = []
    for (let current: unknown = selection; isObject(current); current = current.parent) {
      chain.push({ range: wireRange(current.range as WireRange) })
    }
    return chain
  })
}

export function wireDocumentLinks(links: unknown[]) {
  return {
    links: links
      .filter((link): link is AnyRecord => isObject(link) && isObject(link.range))
      .map((link) => ({
        range: wireRange(link.range as WireRange),
        ...(link.target !== undefined ? { target: wireUri(link.target as Uri) } : {}),
        ...(typeof link.tooltip === "string" ? { tooltip: link.tooltip } : {}),
      })),
  }
}

export function wireInlayHints(result: unknown) {
  if (!Array.isArray(result)) return null
  return {
    hints: result.filter(isObject).map((hint) => ({
      position: wirePosition(hint.position as WirePosition),
      label:
        typeof hint.label === "string"
          ? hint.label
          : (Array.isArray(hint.label) ? hint.label : [])
              .filter(isObject)
              .map((part) => ({ value: String(part.value) })),
      ...(typeof hint.kind === "number" ? { kind: hint.kind } : {}),
      ...(hint.paddingLeft ? { paddingLeft: true } : {}),
      ...(hint.paddingRight ? { paddingRight: true } : {}),
      ...(hint.tooltip !== undefined ? { tooltip: wireDocumentation(hint.tooltip) } : {}),
    })),
  }
}

export function wireInlineCompletions(result: unknown) {
  if (result === undefined || result === null) return null
  const items = Array.isArray(result)
    ? result
    : isObject(result) && Array.isArray(result.items)
      ? result.items
      : []
  return {
    items: items.filter(isObject).map((item) => {
      const insert = item.insertText
      return {
        insertText:
          isObject(insert) && typeof insert.value === "string"
            ? { snippet: insert.value }
            : String(insert ?? ""),
        ...(isObject(item.range) ? { range: wireRange(item.range as unknown as WireRange) } : {}),
        ...(item.command ? { command: wireCommand(item.command) } : {}),
      }
    }),
  }
}

export function wireLinkedEditingRanges(result: unknown) {
  if (!isObject(result) || !Array.isArray(result.ranges)) return null
  return {
    ranges: result.ranges.filter(isObject).map((range) => wireRange(range as unknown as WireRange)),
    ...(result.wordPattern instanceof RegExp ? { wordPattern: result.wordPattern.source } : {}),
  }
}

/**
 * Call- and type-hierarchy items go to the renderer and come back as the
 * argument of the next call. Extensions keep data on them (and compare them
 * by identity), so each one is kept here under an id and handed back as the
 * same object. The oldest are dropped past {@link HIERARCHY_ITEM_LIMIT}.
 */
export const HIERARCHY_ITEM_LIMIT = 2_000

export class HierarchyItems {
  private readonly items = new Map<string, unknown>()
  private next = 0

  wire(item: unknown) {
    if (!isObject(item)) return null
    this.next += 1
    const id = `item-${this.next}`
    this.items.set(id, item)
    if (this.items.size > HIERARCHY_ITEM_LIMIT) {
      this.items.delete(this.items.keys().next().value as string)
    }
    return {
      id,
      name: String(item.name),
      kind: typeof item.kind === "number" ? item.kind : 0,
      detail: String(item.detail ?? ""),
      uri: wireUri(item.uri as Uri),
      range: wireRange(item.range as unknown as WireRange),
      selectionRange: wireRange((item.selectionRange ?? item.range) as WireRange),
      ...(Array.isArray(item.tags) ? { tags: item.tags as number[] } : {}),
    }
  }

  revive(wire: unknown): unknown {
    return isObject(wire) && typeof wire.id === "string" ? this.items.get(wire.id) : undefined
  }
}
