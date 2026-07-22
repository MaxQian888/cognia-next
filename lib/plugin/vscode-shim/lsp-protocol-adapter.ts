/**
 * LSP/VSCode ↔ Monaco type conversion layer.
 *
 * The cognia VS Code reuse layer sits on a hard semantic gap between three
 * coordinate systems:
 *
 *   - **Monaco**: 1-based `lineNumber` / `column`; `MarkerSeverity` is one of
 *     `"error" | "warning" | "info" | "hint"`; `CompletionItemKind` enum
 *     values start at `Method = 0`.
 *   - **VS Code API**: 0-based `line` / `character`; `DiagnosticSeverity` is
 *     `Error = 0, Warning = 1, Information = 2, Hint = 3`;
 *     `CompletionItemKind.Method = 2`.
 *   - **LSP protocol**: 0-based `line` / `character`;
 *     `DiagnosticSeverity = Error = 1, Warning = 2, Information = 3, Hint = 4`;
 *     `CompletionItemKind` values match VS Code (1..25).
 *
 * Without translation, every diagnostic ends up wrong-coloured, every
 * completion gets the wrong icon, every range is off by one line, and every
 * `goto-definition` jumps to the wrong character. This module is the single
 * source of truth for the conversions.
 *
 * All exports are pure functions — no side effects, no DB access, no
 * dependency on Monaco at runtime. The companion `lsp-protocol-adapter.test.ts`
 * holds the conversion contract.
 *
 * Conventions:
 *   - `vscodeXxxToMonaco(...)` translates a VS Code-API-shape (0-based,
 *     severity 0..3) value into a Monaco-shape value.
 *   - `lspXxxToMonaco(...)` translates an LSP-protocol-shape value
 *     (severity 1..4) — used by the cognia-owned LSP client in Phase B.
 *   - `monacoXxxToVscode(...)` translates a Monaco-shape value back into a
 *     VS Code-shape — used when the bridge dispatches a request to the
 *     sidecar (where the extension expects VS Code shapes).
 */

import type {
  MonacoDocumentLink,
  MonacoFoldingRange,
  MonacoHover,
  MonacoInlayHint,
  MonacoLocation,
  MonacoMarker,
  MonacoPosition,
  MonacoRange,
  MonacoSelectionRange,
  MonacoSemanticTokens,
  MonacoSignatureHelp,
  MonacoTextEdit,
  MonacoColorInformation,
} from "./monaco-bridge"

/**
 * Adapter-side completion item — the shape we hand to Monaco's
 * `provideCompletionItems` callback. Distinct from the bridge's narrower
 * `MonacoCompletionItem` because the bridge type pre-dates Phase A and
 * uses `kind?: string`. We emit Monaco's numeric `CompletionItemKind`
 * enum value plus `insertTextRules` (the `InsertAsSnippet = 4` flag) so
 * snippets render correctly.
 */
export interface AdaptedMonacoCompletionItem {
  label: string | { label: string; detail?: string; description?: string }
  kind?: number
  tags?: number[]
  detail?: string
  documentation?: string
  insertText: string
  insertTextRules?: number
  range?: MonacoRange | { insert: MonacoRange; replace: MonacoRange }
  filterText?: string
  sortText?: string
  preselect?: boolean
  commitCharacters?: string[]
  additionalTextEdits?: MonacoTextEdit[]
  command?: { id: string; title: string; arguments?: unknown[] }
}

// =============================================================================
// VS Code / LSP shapes (kept local — we don't import from sidecar).
// =============================================================================

/** VS Code & LSP `Position` (0-based). */
export interface VscodePosition {
  line: number
  character: number
}

/** VS Code & LSP `Range` (0-based). */
export interface VscodeRange {
  start: VscodePosition
  end: VscodePosition
}

/** VS Code & LSP `Location`. */
export interface VscodeLocation {
  uri: string
  range: VscodeRange
}

/** VS Code & LSP `TextEdit`. */
export interface VscodeTextEdit {
  range: VscodeRange
  newText: string
}

/** VS Code & LSP `MarkupContent`. */
export interface VscodeMarkupContent {
  kind: "plaintext" | "markdown"
  value: string
}

/**
 * LSP `MarkedString` (deprecated form). Either a plain string or a
 * `{ language, value }` pair that should render as a fenced code block.
 */
export type VscodeMarkedString = string | { language: string; value: string }

/** VS Code & LSP `Hover`. */
export interface VscodeHover {
  contents:
    VscodeMarkupContent | VscodeMarkedString | Array<VscodeMarkupContent | VscodeMarkedString>
  range?: VscodeRange
}

/**
 * VS Code `Diagnostic`. **Severity is 0-based**:
 *   `Error = 0, Warning = 1, Information = 2, Hint = 3`.
 */
export interface VscodeDiagnostic {
  range: VscodeRange
  severity?: number // 0..3, but treat undefined as Error.
  message: string
  source?: string
  code?: string | number | { value: string | number; target: string }
  tags?: number[]
  relatedInformation?: Array<{ location: VscodeLocation; message: string }>
}

/**
 * LSP `Diagnostic`. **Severity is 1-based**:
 *   `Error = 1, Warning = 2, Information = 3, Hint = 4`.
 */
export interface LspDiagnostic extends Omit<VscodeDiagnostic, "severity"> {
  severity?: 1 | 2 | 3 | 4
}

/** VS Code `CompletionItem`. */
export interface VscodeCompletionItem {
  label: string | { label: string; detail?: string; description?: string }
  /** VSCode/LSP numeric enum value 1..25. */
  kind?: number
  detail?: string
  documentation?: string | VscodeMarkupContent
  /** Plain text by default. */
  insertText?: string
  /** Snippet semantics if specified — translates to `InsertAsSnippet` rules. */
  insertTextFormat?: 1 | 2 // 1 = plaintext, 2 = snippet
  range?: VscodeRange | { inserting: VscodeRange; replacing: VscodeRange }
  filterText?: string
  sortText?: string
  tags?: number[]
  preselect?: boolean
  commitCharacters?: string[]
  additionalTextEdits?: VscodeTextEdit[]
  command?: { command: string; title: string; arguments?: unknown[] }
}

/** Result of a completion request — flat array or `CompletionList`. */
export type VscodeCompletionResult =
  VscodeCompletionItem[] | { isIncomplete: boolean; items: VscodeCompletionItem[] }

export interface VscodeInlineCompletionItem {
  insertText: string | { value: string } | { snippet: string }
  range?: VscodeRange
  additionalTextEdits?: VscodeTextEdit[]
  command?: { command: string; title: string; arguments?: unknown[] }
  completeBracketPairs?: boolean
}

export interface VscodeInlineCompletionList {
  items: VscodeInlineCompletionItem[]
  commands?: Array<
    | { command: string; title: string; arguments?: unknown[] }
    | {
        command: { command: string; title: string; arguments?: unknown[] }
        icon?: unknown
      }
  >
  suppressSuggestions?: boolean
  enableForwardStability?: boolean
}

export type VscodeInlineCompletionResult = VscodeInlineCompletionItem[] | VscodeInlineCompletionList

/** LSP `SignatureHelp`. */
export interface VscodeSignatureHelp {
  signatures: Array<{
    label: string
    documentation?: string | VscodeMarkupContent
    parameters?: Array<{
      label: string | [number, number]
      documentation?: string | VscodeMarkupContent
    }>
  }>
  activeSignature?: number
  activeParameter?: number
}

/** VS Code / LSP `CodeLens`. */
export interface VscodeCodeLens {
  range: VscodeRange
  command?: { title: string; command: string; arguments?: unknown[] }
}

/** VS Code / LSP `DocumentSymbol`. */
export interface VscodeDocumentSymbol {
  name: string
  detail?: string
  kind: number
  range: VscodeRange
  selectionRange: VscodeRange
  children?: VscodeDocumentSymbol[]
  tags?: number[]
}

/** VS Code / LSP `InlayHint`. */
export interface VscodeInlayHint {
  position: VscodePosition
  label: string | Array<{ value: string }>
  kind?: 1 | 2 // 1 = type, 2 = parameter
  paddingLeft?: boolean
  paddingRight?: boolean
  tooltip?: string | VscodeMarkupContent
}

/** VS Code / LSP `FoldingRange`. */
export interface VscodeFoldingRange {
  startLine: number
  endLine: number
  startCharacter?: number
  endCharacter?: number
  kind?: string
}

/** VS Code / LSP `SelectionRange` (recursive). */
export interface VscodeSelectionRange {
  range: VscodeRange
  parent?: VscodeSelectionRange
}

/** VS Code / LSP `DocumentLink`. */
export interface VscodeDocumentLink {
  range: VscodeRange
  target?: string
  tooltip?: string
}

/** VS Code / LSP `ColorInformation`. */
export interface VscodeColorInformation {
  range: VscodeRange
  color: { red: number; green: number; blue: number; alpha: number }
}

/** VS Code / LSP `SemanticTokens`. */
export interface VscodeSemanticTokens {
  resultId?: string
  data: number[]
}

/** VS Code `WorkspaceEdit` (subset cognia handles). */
export interface VscodeWorkspaceEdit {
  changes?: Record<string, VscodeTextEdit[]>
  documentChanges?: Array<{
    textDocument: { uri: string; version?: number | null }
    edits: VscodeTextEdit[]
  }>
}

// =============================================================================
// Position & Range (the two most-load-bearing conversions).
// =============================================================================

/**
 * VS Code `Position { line, character }` (0-based) →
 * Monaco `MonacoPosition { lineNumber, column }` (1-based).
 */
export function vscodePositionToMonaco(p: VscodePosition): MonacoPosition {
  return { lineNumber: p.line + 1, column: p.character + 1 }
}

/** Inverse of `vscodePositionToMonaco`. */
export function monacoPositionToVscode(p: MonacoPosition): VscodePosition {
  return { line: p.lineNumber - 1, character: p.column - 1 }
}

/** VS Code `Range { start, end }` (0-based) → Monaco `MonacoRange` (1-based). */
export function vscodeRangeToMonaco(r: VscodeRange): MonacoRange {
  return {
    startLineNumber: r.start.line + 1,
    startColumn: r.start.character + 1,
    endLineNumber: r.end.line + 1,
    endColumn: r.end.character + 1,
  }
}

/** Inverse of `vscodeRangeToMonaco`. */
export function monacoRangeToVscode(r: MonacoRange): VscodeRange {
  return {
    start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
    end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
  }
}

// =============================================================================
// CompletionItem.
// =============================================================================

/**
 * VS Code & LSP both use the same 1..25 enum numbering for
 * `CompletionItemKind`. Monaco uses a DIFFERENT enum that starts at
 * `Method = 0`. The mapping below is taken from `monaco-editor`'s own
 * `languages/types.ts` (Monaco 0.55).
 *
 * Anything outside 1..25 falls back to Monaco's `Text = 18`.
 */
const VSCODE_TO_MONACO_COMPLETION_KIND: Record<number, number> = {
  1: 18, // Text → Text
  2: 0, // Method → Method
  3: 1, // Function → Function
  4: 2, // Constructor → Constructor
  5: 3, // Field → Field
  6: 4, // Variable → Variable
  7: 5, // Class → Class
  8: 7, // Interface → Interface
  9: 8, // Module → Module
  10: 9, // Property → Property
  11: 12, // Unit → Unit
  12: 13, // Value → Value
  13: 15, // Enum → Enum
  14: 17, // Keyword → Keyword
  15: 28, // Snippet → Snippet
  16: 19, // Color → Color
  17: 20, // File → File
  18: 21, // Reference → Reference
  19: 23, // Folder → Folder
  20: 16, // EnumMember → EnumMember
  21: 14, // Constant → Constant
  22: 6, // Struct → Struct
  23: 10, // Event → Event
  24: 11, // Operator → Operator
  25: 24, // TypeParameter → TypeParameter
}

const MONACO_TEXT_KIND = 18

/** VS Code/LSP `CompletionItemKind` (1..25) → Monaco numeric value. */
export function vscodeCompletionKindToMonaco(kind: number | undefined): number {
  if (kind == null) return MONACO_TEXT_KIND
  return VSCODE_TO_MONACO_COMPLETION_KIND[kind] ?? MONACO_TEXT_KIND
}

/**
 * Translate a VS Code `CompletionItem` into a Monaco-shape one.
 *
 * Notes:
 *   - When `insertTextFormat === 2` (Snippet), Monaco needs
 *     `insertTextRules = InsertAsSnippet (= 4)` to interpret `${1:foo}`
 *     placeholders. We emit that flag inline so the bridge consumer can
 *     forward it verbatim to Monaco's provider result.
 *   - Both flavours of `range` are preserved. Monaco supports distinct
 *     insert/replace ranges, so collapsing them would overwrite text that
 *     VS Code providers intentionally left outside the insertion range.
 *   - `documentation` reduces to its `value` when it's MarkupContent.
 */
export function vscodeCompletionItemToMonaco(
  item: VscodeCompletionItem
): AdaptedMonacoCompletionItem {
  const range =
    item.range == null
      ? undefined
      : "inserting" in item.range
        ? {
            insert: vscodeRangeToMonaco(item.range.inserting),
            replace: vscodeRangeToMonaco(item.range.replacing),
          }
        : vscodeRangeToMonaco(item.range)

  const plainLabel = typeof item.label === "string" ? item.label : item.label.label

  return {
    label: item.label,
    kind: vscodeCompletionKindToMonaco(item.kind),
    tags: item.tags,
    detail: item.detail,
    documentation:
      typeof item.documentation === "string"
        ? item.documentation
        : (item.documentation?.value ?? undefined),
    insertText: item.insertText ?? plainLabel,
    insertTextRules: item.insertTextFormat === 2 ? 4 : undefined,
    range,
    filterText: item.filterText,
    sortText: item.sortText,
    preselect: item.preselect,
    commitCharacters: item.commitCharacters,
    additionalTextEdits: item.additionalTextEdits?.map(vscodeTextEditToMonaco),
    command: item.command
      ? { id: item.command.command, title: item.command.title, arguments: item.command.arguments }
      : undefined,
  }
}

// =============================================================================
// Diagnostics.
// =============================================================================

/** VS Code `DiagnosticSeverity` (0..3) → Monaco string severity. */
export function vscodeDiagnosticSeverityToMonaco(
  severity: number | undefined
): MonacoMarker["severity"] {
  switch (severity) {
    case 0:
      return "error"
    case 1:
      return "warning"
    case 2:
      return "info"
    case 3:
      return "hint"
    default:
      return "error" // undefined defaults to Error in VS Code semantics.
  }
}

/** LSP `DiagnosticSeverity` (1..4) → Monaco string severity. */
export function lspDiagnosticSeverityToMonaco(
  severity: number | undefined
): MonacoMarker["severity"] {
  switch (severity) {
    case 1:
      return "error"
    case 2:
      return "warning"
    case 3:
      return "info"
    case 4:
      return "hint"
    default:
      return "error"
  }
}

/** VS Code `Diagnostic` → Monaco `MonacoMarker`. */
export function vscodeDiagnosticToMonacoMarker(d: VscodeDiagnostic): MonacoMarker {
  return {
    severity: vscodeDiagnosticSeverityToMonaco(d.severity),
    message: d.message,
    range: vscodeRangeToMonaco(d.range),
    source: d.source,
  }
}

/** LSP `Diagnostic` → Monaco `MonacoMarker`. */
export function lspDiagnosticToMonacoMarker(d: LspDiagnostic): MonacoMarker {
  return {
    severity: lspDiagnosticSeverityToMonaco(d.severity),
    message: d.message,
    range: vscodeRangeToMonaco(d.range),
    source: d.source,
  }
}

// =============================================================================
// Hover.
// =============================================================================

/**
 * Render any of LSP's three hover-content shapes (string, MarkdownString,
 * MarkedString, or arrays thereof) into Monaco's `string[]` shape.
 *
 * Fenced-code MarkedStrings are converted to triple-backtick markdown so
 * Monaco renders them as code blocks — Monaco accepts plain markdown
 * strings in `MonacoHover.contents`.
 */
function flattenHoverContent(
  c: VscodeMarkupContent | VscodeMarkedString | Array<VscodeMarkupContent | VscodeMarkedString>
): string[] {
  const items = Array.isArray(c) ? c : [c]
  const out: string[] = []
  for (const item of items) {
    if (typeof item === "string") {
      out.push(item)
    } else if ("language" in item) {
      // MarkedString fenced form
      out.push("```" + item.language + "\n" + item.value + "\n```")
    } else if ("kind" in item) {
      // MarkupContent (plaintext or markdown). Cognia renders both as
      // markdown; plaintext rendering is up to the consumer.
      out.push(item.value)
    }
  }
  return out
}

/** VS Code/LSP `Hover` → Monaco `MonacoHover`. */
export function vscodeHoverToMonaco(h: VscodeHover): MonacoHover {
  return {
    contents: flattenHoverContent(h.contents),
    range: h.range ? vscodeRangeToMonaco(h.range) : undefined,
  }
}

// =============================================================================
// Location / TextEdit / WorkspaceEdit.
// =============================================================================

/** VS Code/LSP `Location` → Monaco `MonacoLocation`. */
export function vscodeLocationToMonaco(loc: VscodeLocation): MonacoLocation {
  return { uri: loc.uri, range: vscodeRangeToMonaco(loc.range) }
}

export function vscodeLocationsToMonaco(locs: VscodeLocation[]): MonacoLocation[] {
  return locs.map(vscodeLocationToMonaco)
}

/** VS Code/LSP `TextEdit` → Monaco `MonacoTextEdit`. */
export function vscodeTextEditToMonaco(edit: VscodeTextEdit): MonacoTextEdit {
  return { range: vscodeRangeToMonaco(edit.range), text: edit.newText }
}

export function vscodeTextEditsToMonaco(edits: VscodeTextEdit[]): MonacoTextEdit[] {
  return edits.map(vscodeTextEditToMonaco)
}

/**
 * Cognia's bridge-shape workspace edit. Both LSP `changes` and
 * `documentChanges` collapse into a flat `(uri, MonacoTextEdit[])[]`
 * because Monaco's bridge surface doesn't model versioned edits.
 */
export interface MonacoWorkspaceEdit {
  edits: Array<{ resource: string; edits: MonacoTextEdit[] }>
}

/** VS Code/LSP `WorkspaceEdit` → cognia-shape `MonacoWorkspaceEdit`. */
export function vscodeWorkspaceEditToMonaco(we: VscodeWorkspaceEdit): MonacoWorkspaceEdit {
  const grouped: Array<{ resource: string; edits: MonacoTextEdit[] }> = []
  if (we.changes) {
    for (const [uri, edits] of Object.entries(we.changes)) {
      grouped.push({ resource: uri, edits: vscodeTextEditsToMonaco(edits) })
    }
  }
  if (we.documentChanges) {
    for (const dc of we.documentChanges) {
      grouped.push({
        resource: dc.textDocument.uri,
        edits: vscodeTextEditsToMonaco(dc.edits),
      })
    }
  }
  return { edits: grouped }
}

// =============================================================================
// SignatureHelp / CodeLens / DocumentSymbol / InlayHint / SemanticTokens.
// =============================================================================

/** VS Code/LSP `SignatureHelp` → Monaco `MonacoSignatureHelp`. */
export function vscodeSignatureHelpToMonaco(sh: VscodeSignatureHelp): MonacoSignatureHelp {
  return {
    signatures: sh.signatures.map((s) => ({
      label: s.label,
      documentation: typeof s.documentation === "string" ? s.documentation : s.documentation?.value,
      parameters: s.parameters,
    })),
    activeSignature: sh.activeSignature ?? 0,
    activeParameter: sh.activeParameter ?? 0,
  }
}

/** VS Code/LSP `CodeLens` → Monaco-bridge `MonacoCodeLens`. */
export function vscodeCodeLensToMonaco(cl: VscodeCodeLens): {
  range: MonacoRange
  command?: { id: string; title: string; arguments?: unknown[] }
} {
  return {
    range: vscodeRangeToMonaco(cl.range),
    command: cl.command
      ? { id: cl.command.command, title: cl.command.title, arguments: cl.command.arguments }
      : undefined,
  }
}

/** Recursive Monaco shape for `DocumentSymbol` (mirrors Monaco's API). */
export interface MonacoDocumentSymbol {
  name: string
  detail: string
  kind: number
  range: MonacoRange
  selectionRange: MonacoRange
  children?: MonacoDocumentSymbol[]
  tags?: number[]
}

/** VS Code/LSP `DocumentSymbol` → Monaco shape. */
export function vscodeDocumentSymbolToMonaco(ds: VscodeDocumentSymbol): MonacoDocumentSymbol {
  return {
    name: ds.name,
    detail: ds.detail ?? "",
    kind: ds.kind, // SymbolKind values match between VS Code/LSP and Monaco.
    range: vscodeRangeToMonaco(ds.range),
    selectionRange: vscodeRangeToMonaco(ds.selectionRange),
    children: ds.children?.map(vscodeDocumentSymbolToMonaco),
    tags: ds.tags,
  }
}

/** VS Code/LSP `InlayHint` → Monaco-bridge `MonacoInlayHint`. */
export function vscodeInlayHintToMonaco(ih: VscodeInlayHint): MonacoInlayHint {
  return {
    position: vscodePositionToMonaco(ih.position),
    label: typeof ih.label === "string" ? ih.label : ih.label.map((p) => p.value).join(""),
    kind: ih.kind === 1 ? "type" : ih.kind === 2 ? "parameter" : undefined,
  }
}

/** VS Code/LSP `FoldingRange` → Monaco `MonacoFoldingRange`. */
export function vscodeFoldingRangeToMonaco(fr: VscodeFoldingRange): MonacoFoldingRange {
  // Monaco folding ranges use 1-based line numbers; LSP/VSCode use 0-based.
  return {
    start: fr.startLine + 1,
    end: fr.endLine + 1,
    kind: fr.kind,
  }
}

/** VS Code/LSP `SelectionRange` (recursive) → Monaco shape. */
export function vscodeSelectionRangeToMonaco(sr: VscodeSelectionRange): MonacoSelectionRange {
  return {
    range: vscodeRangeToMonaco(sr.range),
    parent: sr.parent ? vscodeSelectionRangeToMonaco(sr.parent) : undefined,
  }
}

/** VS Code/LSP `DocumentLink` → Monaco `MonacoDocumentLink`. */
export function vscodeDocumentLinkToMonaco(dl: VscodeDocumentLink): MonacoDocumentLink {
  return {
    range: vscodeRangeToMonaco(dl.range),
    url: dl.target,
    tooltip: dl.tooltip,
  }
}

/** VS Code/LSP `ColorInformation` → Monaco `MonacoColorInformation`. */
export function vscodeColorInformationToMonaco(ci: VscodeColorInformation): MonacoColorInformation {
  return { range: vscodeRangeToMonaco(ci.range), color: ci.color }
}

/** VS Code/LSP `SemanticTokens` → Monaco `MonacoSemanticTokens` (pass-through). */
export function vscodeSemanticTokensToMonaco(st: VscodeSemanticTokens): MonacoSemanticTokens {
  return { data: st.data, resultId: st.resultId }
}

// =============================================================================
// Convenience entry-points for renderer-side adapters.
// =============================================================================

/**
 * Convert any completion result (flat array or `CompletionList`) into the
 * Monaco-bridge shape used in `provideCompletionItems`. Returns `null` when
 * the input is null/undefined so the bridge can short-circuit.
 */
export function vscodeCompletionResultToMonaco(
  result: VscodeCompletionResult | null | undefined
): { suggestions: AdaptedMonacoCompletionItem[]; incomplete?: boolean } | null {
  if (result == null) return null
  const items = Array.isArray(result) ? result : result.items
  return {
    suggestions: items.map(vscodeCompletionItemToMonaco),
    ...(Array.isArray(result) ? {} : { incomplete: result.isIncomplete }),
  }
}

export interface AdaptedMonacoInlineCompletionItem {
  insertText: string | { snippet: string }
  range?: MonacoRange
  additionalTextEdits?: MonacoTextEdit[]
  command?: { id: string; title: string; arguments?: unknown[] }
  completeBracketPairs?: boolean
}

export interface AdaptedMonacoInlineCompletions {
  items: AdaptedMonacoInlineCompletionItem[]
  commands?: Array<{
    command: { id: string; title: string; arguments?: unknown[] }
    icon?: unknown
  }>
  suppressSuggestions?: boolean
  enableForwardStability?: boolean
}

function adaptCommand(command: { command: string; title: string; arguments?: unknown[] }): {
  id: string
  title: string
  arguments?: unknown[]
} {
  return { id: command.command, title: command.title, arguments: command.arguments }
}

function vscodeInlineCompletionItemToMonaco(
  item: VscodeInlineCompletionItem
): AdaptedMonacoInlineCompletionItem {
  const insertText =
    typeof item.insertText === "string"
      ? item.insertText
      : "value" in item.insertText
        ? { snippet: item.insertText.value }
        : item.insertText
  return {
    insertText,
    range: item.range ? vscodeRangeToMonaco(item.range) : undefined,
    additionalTextEdits: item.additionalTextEdits?.map(vscodeTextEditToMonaco),
    command: item.command ? adaptCommand(item.command) : undefined,
    completeBracketPairs: item.completeBracketPairs,
  }
}

/** Convert VS Code inline-completion arrays/lists into Monaco's result shape. */
export function vscodeInlineCompletionResultToMonaco(
  result: VscodeInlineCompletionResult | null | undefined
): AdaptedMonacoInlineCompletions | null {
  if (result == null) return null
  const list: VscodeInlineCompletionList = Array.isArray(result) ? { items: result } : result
  return {
    items: list.items.map(vscodeInlineCompletionItemToMonaco),
    ...(list.commands
      ? {
          commands: list.commands.map((entry) => {
            const nested = "title" in entry ? entry : entry.command
            return {
              command: adaptCommand(nested),
              ...("icon" in entry ? { icon: entry.icon } : {}),
            }
          }),
        }
      : {}),
    ...(list.suppressSuggestions == null ? {} : { suppressSuggestions: list.suppressSuggestions }),
    ...(list.enableForwardStability == null
      ? {}
      : { enableForwardStability: list.enableForwardStability }),
  }
}

/**
 * Convert an LSP-protocol `PublishDiagnosticsParams` (the message LSP servers
 * push spontaneously) into the bridge's `setDiagnostics` payload. Used by
 * Phase B's `CogniaLspClient`.
 */
export function lspPublishDiagnosticsToBridgePayload(params: {
  uri: string
  diagnostics: LspDiagnostic[]
}): { uri: string; markers: MonacoMarker[] } {
  return {
    uri: params.uri,
    markers: params.diagnostics.map(lspDiagnosticToMonacoMarker),
  }
}
