/**
 * The rest of VS Code's value types: the classes and enums language
 * features, `vscode-languageclient` and ordinary extensions construct.
 *
 * Constructor shapes and enum values follow `vscode.d.ts` (API 1.91) so an
 * extension built against the real API gets the object it expects and an
 * enum value means what it means there. They carry data only; behaviour
 * lives in the namespaces and on the renderer side.
 */

import { Position, Range, Uri, TextEdit } from "./types"

// ── Enums ───────────────────────────────────────────────────────────────

export const ExtensionMode = { Production: 1, Development: 2, Test: 3 } as const
export const ExtensionKind = { UI: 1, Workspace: 2 } as const
export const UIKind = { Desktop: 1, Web: 2 } as const
export const LogLevel = { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 } as const
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const
export const EndOfLine = { LF: 1, CRLF: 2 } as const
export const TextEditorRevealType = {
  Default: 0,
  InCenter: 1,
  InCenterIfOutsideViewport: 2,
  AtTop: 3,
} as const
export const TextEditorSelectionChangeKind = { Keyboard: 1, Mouse: 2, Command: 3 } as const
export const TextDocumentChangeReason = { Undo: 1, Redo: 2 } as const
export const DiagnosticTag = { Unnecessary: 1, Deprecated: 2 } as const
export const CompletionItemTag = { Deprecated: 1 } as const
export const CompletionTriggerKind = {
  Invoke: 0,
  TriggerCharacter: 1,
  TriggerForIncompleteCompletions: 2,
} as const
export const SignatureHelpTriggerKind = {
  Invoke: 1,
  TriggerCharacter: 2,
  ContentChange: 3,
} as const
export const InlineCompletionTriggerKind = { Invoke: 0, Automatic: 1 } as const
export const CodeActionTriggerKind = { Invoke: 1, Automatic: 2 } as const
export const DocumentHighlightKind = { Text: 0, Read: 1, Write: 2 } as const
export const SymbolKind = {
  File: 0,
  Module: 1,
  Namespace: 2,
  Package: 3,
  Class: 4,
  Method: 5,
  Property: 6,
  Field: 7,
  Constructor: 8,
  Enum: 9,
  Interface: 10,
  Function: 11,
  Variable: 12,
  Constant: 13,
  String: 14,
  Number: 15,
  Boolean: 16,
  Array: 17,
  Object: 18,
  Key: 19,
  Null: 20,
  EnumMember: 21,
  Struct: 22,
  Event: 23,
  Operator: 24,
  TypeParameter: 25,
} as const
export const SymbolTag = { Deprecated: 1 } as const
export const FoldingRangeKind = { Comment: 1, Imports: 2, Region: 3 } as const
export const InlayHintKind = { Type: 1, Parameter: 2 } as const
export const IndentAction = { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 } as const
export const OverviewRulerLane = { Left: 1, Center: 2, Right: 4, Full: 7 } as const
export const DecorationRangeBehavior = {
  OpenOpen: 0,
  ClosedClosed: 1,
  OpenClosed: 2,
  ClosedOpen: 3,
} as const
export const QuickPickItemKind = { Separator: -1, Default: 0 } as const
export const InputBoxValidationSeverity = { Info: 1, Warning: 2, Error: 3 } as const
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const
export const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 } as const
export const FileChangeType = { Changed: 1, Created: 2, Deleted: 3 } as const
export const FilePermission = { Readonly: 1 } as const
export const NotebookCellKind = { Markup: 1, Code: 2 } as const
export const LanguageStatusSeverity = { Information: 0, Warning: 1, Error: 2 } as const
export const TaskRevealKind = { Always: 1, Silent: 2, Never: 3 } as const
export const TaskPanelKind = { Shared: 1, Dedicated: 2, New: 3 } as const
export const TaskScope = { Global: 1, Workspace: 2 } as const
export const EnvironmentVariableMutatorType = { Replace: 1, Append: 2, Prepend: 3 } as const

// ── Errors ──────────────────────────────────────────────────────────────

export class CancellationError extends Error {
  constructor() {
    super("Canceled")
    this.name = "Canceled"
  }
}

export class FileSystemError extends Error {
  static FileNotFound(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, "FileNotFound")
  }
  static FileExists(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, "FileExists")
  }
  static FileNotADirectory(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, "FileNotADirectory")
  }
  static FileIsADirectory(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, "FileIsADirectory")
  }
  static NoPermissions(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, "NoPermissions")
  }
  static Unavailable(messageOrUri?: string | Uri): FileSystemError {
    return new FileSystemError(messageOrUri, "Unavailable")
  }
  constructor(
    messageOrUri?: string | Uri,
    public readonly code: string = "Unknown"
  ) {
    super(typeof messageOrUri === "string" ? messageOrUri : (messageOrUri?.toString() ?? code))
    this.name = `${code} (FileSystemError)`
  }
}

// ── Theming ─────────────────────────────────────────────────────────────

export class ThemeColor {
  constructor(public readonly id: string) {}
}

export class ThemeIcon {
  static readonly File = new ThemeIcon("file")
  static readonly Folder = new ThemeIcon("folder")
  constructor(
    public readonly id: string,
    public readonly color?: ThemeColor
  ) {}
}

/** The built-in quick input buttons; `Back` is the only one VS Code defines. */
export const QuickInputButtons = {
  Back: { iconPath: new ThemeIcon("arrow-left"), tooltip: "Back" },
} as const

// ── Locations and diagnostics ───────────────────────────────────────────

export class Location {
  public range: Range
  constructor(
    public uri: Uri,
    rangeOrPosition: Range | Position
  ) {
    this.range =
      rangeOrPosition instanceof Position
        ? new Range(rangeOrPosition, rangeOrPosition)
        : rangeOrPosition
  }
}

export class DiagnosticRelatedInformation {
  constructor(
    public location: Location,
    public message: string
  ) {}
}

export class Diagnostic {
  source?: string
  code?: string | number | { value: string | number; target: Uri }
  relatedInformation?: DiagnosticRelatedInformation[]
  tags?: number[]
  constructor(
    public range: Range,
    public message: string,
    public severity: number = 0
  ) {}
}

// ── Commands, completion and hover ──────────────────────────────────────

export interface Command {
  title: string
  command: string
  tooltip?: string
  arguments?: unknown[]
}

export class SnippetString {
  constructor(public value = "") {}
  appendText(text: string): SnippetString {
    this.value += text.replace(/[$}\\]/g, "\\$&")
    return this
  }
  appendTabstop(index = 1): SnippetString {
    this.value += `$${index}`
    return this
  }
  appendPlaceholder(
    value: string | ((snippet: SnippetString) => unknown),
    index = 1
  ): SnippetString {
    const inner = typeof value === "function" ? (value(new SnippetString()), "") : value
    this.value += `\${${index}:${inner}}`
    return this
  }
  appendChoice(values: string[], index = 1): SnippetString {
    this.value += `\${${index}|${values.join(",")}|}`
    return this
  }
  appendVariable(
    name: string,
    defaultValue: string | ((snippet: SnippetString) => unknown)
  ): SnippetString {
    const fallback = typeof defaultValue === "function" ? "" : defaultValue
    this.value += `\${${name}:${fallback}}`
    return this
  }
}

export class SnippetTextEdit {
  static replace(range: Range, snippet: SnippetString): SnippetTextEdit {
    return new SnippetTextEdit(range, snippet)
  }
  static insert(position: Position, snippet: SnippetString): SnippetTextEdit {
    return new SnippetTextEdit(new Range(position, position), snippet)
  }
  constructor(
    public range: Range,
    public snippet: SnippetString
  ) {}
}

export class CompletionItem {
  kind?: number
  tags?: number[]
  detail?: string
  documentation?: string | { value: string }
  sortText?: string
  filterText?: string
  preselect?: boolean
  insertText?: string | SnippetString
  range?: Range | { inserting: Range; replacing: Range }
  commitCharacters?: string[]
  keepWhitespace?: boolean
  additionalTextEdits?: TextEdit[]
  command?: Command
  constructor(
    public label: string | { label: string; detail?: string; description?: string },
    kind?: number
  ) {
    this.kind = kind
  }
}

export class CompletionList {
  constructor(
    public items: CompletionItem[] = [],
    public isIncomplete = false
  ) {}
}

export class Hover {
  public contents: unknown[]
  constructor(
    contents: unknown,
    public range?: Range
  ) {
    this.contents = Array.isArray(contents) ? contents : [contents]
  }
}

export class EvaluatableExpression {
  constructor(
    public range: Range,
    public expression?: string
  ) {}
}

export class InlineValueText {
  constructor(
    public range: Range,
    public text: string
  ) {}
}

export class InlineValueVariableLookup {
  constructor(
    public range: Range,
    public variableName?: string,
    public caseSensitiveLookup = true
  ) {}
}

export class InlineValueEvaluatableExpression {
  constructor(
    public range: Range,
    public expression?: string
  ) {}
}

export class InlineCompletionItem {
  filterText?: string
  command?: Command
  constructor(
    public insertText: string | SnippetString,
    public range?: Range,
    command?: Command
  ) {
    this.command = command
  }
}

export class InlineCompletionList {
  constructor(public items: InlineCompletionItem[]) {}
}

// ── Signature help ──────────────────────────────────────────────────────

export class ParameterInformation {
  constructor(
    public label: string | [number, number],
    public documentation?: string | { value: string }
  ) {}
}

export class SignatureInformation {
  parameters: ParameterInformation[] = []
  activeParameter?: number
  constructor(
    public label: string,
    public documentation?: string | { value: string }
  ) {}
}

export class SignatureHelp {
  signatures: SignatureInformation[] = []
  activeSignature = 0
  activeParameter = 0
}

// ── Code actions and lenses ─────────────────────────────────────────────

export class CodeActionKind {
  static readonly Empty = new CodeActionKind("")
  static readonly QuickFix = new CodeActionKind("quickfix")
  static readonly Refactor = new CodeActionKind("refactor")
  static readonly RefactorExtract = new CodeActionKind("refactor.extract")
  static readonly RefactorInline = new CodeActionKind("refactor.inline")
  static readonly RefactorMove = new CodeActionKind("refactor.move")
  static readonly RefactorRewrite = new CodeActionKind("refactor.rewrite")
  static readonly Source = new CodeActionKind("source")
  static readonly SourceOrganizeImports = new CodeActionKind("source.organizeImports")
  static readonly SourceFixAll = new CodeActionKind("source.fixAll")
  static readonly Notebook = new CodeActionKind("notebook")
  private constructor(public readonly value: string) {}
  append(parts: string): CodeActionKind {
    return new CodeActionKind(this.value ? `${this.value}.${parts}` : parts)
  }
  intersects(other: CodeActionKind): boolean {
    return this.contains(other) || other.contains(this)
  }
  contains(other: CodeActionKind): boolean {
    return (
      this.value === "" || other.value === this.value || other.value.startsWith(`${this.value}.`)
    )
  }
  toJSON(): string {
    return this.value
  }
}

export class CodeAction {
  edit?: unknown
  diagnostics?: Diagnostic[]
  command?: Command
  isPreferred?: boolean
  disabled?: { reason: string }
  constructor(
    public title: string,
    public kind?: CodeActionKind
  ) {}
}

export class CodeLens {
  constructor(
    public range: Range,
    public command?: Command
  ) {}
  get isResolved(): boolean {
    return this.command !== undefined
  }
}

// ── Symbols, highlights, links ──────────────────────────────────────────

export class DocumentHighlight {
  constructor(
    public range: Range,
    public kind: number = DocumentHighlightKind.Text
  ) {}
}

export class DocumentLink {
  tooltip?: string
  constructor(
    public range: Range,
    public target?: Uri
  ) {}
}

export class SymbolInformation {
  tags?: number[]
  public location: Location
  constructor(
    public name: string,
    public kind: number,
    containerNameOrRange: string | Range,
    locationOrUri?: Location | Uri,
    public containerName = ""
  ) {
    if (typeof containerNameOrRange === "string") {
      this.containerName = containerNameOrRange
      this.location = locationOrUri as Location
    } else {
      this.location = new Location(locationOrUri as Uri, containerNameOrRange)
    }
  }
}

export class DocumentSymbol {
  tags?: number[]
  children: DocumentSymbol[] = []
  constructor(
    public name: string,
    public detail: string,
    public kind: number,
    public range: Range,
    public selectionRange: Range
  ) {}
}

// ── Colors, folding, selection, inlay hints, linked editing ────────────

export class Color {
  constructor(
    public readonly red: number,
    public readonly green: number,
    public readonly blue: number,
    public readonly alpha: number
  ) {}
}

export class ColorInformation {
  constructor(
    public range: Range,
    public color: Color
  ) {}
}

export class ColorPresentation {
  textEdit?: TextEdit
  additionalTextEdits?: TextEdit[]
  constructor(public label: string) {}
}

export class FoldingRange {
  constructor(
    public start: number,
    public end: number,
    public kind?: number
  ) {}
}

export class SelectionRange {
  constructor(
    public range: Range,
    public parent?: SelectionRange
  ) {}
}

export class InlayHintLabelPart {
  tooltip?: string | { value: string }
  location?: Location
  command?: Command
  constructor(public value: string) {}
}

export class InlayHint {
  tooltip?: string | { value: string }
  textEdits?: TextEdit[]
  paddingLeft?: boolean
  paddingRight?: boolean
  constructor(
    public position: Position,
    public label: string | InlayHintLabelPart[],
    public kind?: number
  ) {}
}

export class LinkedEditingRanges {
  constructor(
    public readonly ranges: Range[],
    public readonly wordPattern?: RegExp
  ) {}
}

// ── Semantic tokens ─────────────────────────────────────────────────────

export class SemanticTokensLegend {
  constructor(
    public readonly tokenTypes: string[],
    public readonly tokenModifiers: string[] = []
  ) {}
}

export class SemanticTokens {
  constructor(
    public readonly data: Uint32Array,
    public readonly resultId?: string
  ) {}
}

export class SemanticTokensEdit {
  constructor(
    public readonly start: number,
    public readonly deleteCount: number,
    public readonly data?: Uint32Array
  ) {}
}

export class SemanticTokensEdits {
  constructor(
    public readonly edits: SemanticTokensEdit[],
    public readonly resultId?: string
  ) {}
}

/** Collects tokens in document order and encodes them relative, as VS Code does. */
export class SemanticTokensBuilder {
  private readonly data: number[] = []
  private previousLine = 0
  private previousChar = 0
  constructor(private readonly legend?: SemanticTokensLegend) {}
  push(
    lineOrRange: number | Range,
    charOrType: number | string,
    lengthOrModifiers?: number | string[],
    tokenType?: number,
    tokenModifiers = 0
  ): void {
    if (typeof lineOrRange === "number") {
      this.add(
        lineOrRange,
        charOrType as number,
        lengthOrModifiers as number,
        tokenType ?? 0,
        tokenModifiers
      )
      return
    }
    const type = this.legend?.tokenTypes.indexOf(charOrType as string) ?? -1
    if (type < 0) throw new Error(`unknown token type ${String(charOrType)}`)
    const modifiers = ((lengthOrModifiers as string[] | undefined) ?? []).reduce((bits, name) => {
      const index = this.legend?.tokenModifiers.indexOf(name) ?? -1
      if (index < 0) throw new Error(`unknown token modifier ${name}`)
      return bits | (1 << index)
    }, 0)
    const range = lineOrRange
    this.add(
      range.start.line,
      range.start.character,
      range.end.character - range.start.character,
      type,
      modifiers
    )
  }
  build(resultId?: string): SemanticTokens {
    return new SemanticTokens(Uint32Array.from(this.data), resultId)
  }
  private add(line: number, char: number, length: number, type: number, modifiers: number): void {
    const deltaLine = line - this.previousLine
    const deltaChar = deltaLine === 0 ? char - this.previousChar : char
    this.data.push(deltaLine, deltaChar, length, type, modifiers)
    this.previousLine = line
    this.previousChar = char
  }
}

// ── Hierarchies ─────────────────────────────────────────────────────────

export class CallHierarchyItem {
  tags?: number[]
  constructor(
    public kind: number,
    public name: string,
    public detail: string,
    public uri: Uri,
    public range: Range,
    public selectionRange: Range
  ) {}
}

export class CallHierarchyIncomingCall {
  constructor(
    public from: CallHierarchyItem,
    public fromRanges: Range[]
  ) {}
}

export class CallHierarchyOutgoingCall {
  constructor(
    public to: CallHierarchyItem,
    public fromRanges: Range[]
  ) {}
}

export class TypeHierarchyItem {
  tags?: number[]
  constructor(
    public kind: number,
    public name: string,
    public detail: string,
    public uri: Uri,
    public range: Range,
    public selectionRange: Range
  ) {}
}

// ── Patterns, tabs, trees ───────────────────────────────────────────────

export class RelativePattern {
  public readonly baseUri: Uri
  public readonly base: string
  constructor(
    base: Uri | string | { uri: Uri },
    public readonly pattern: string
  ) {
    this.baseUri = typeof base === "string" ? Uri.file(base) : base instanceof Uri ? base : base.uri
    this.base = this.baseUri.fsPath
  }
}

export class TabInputText {
  constructor(public readonly uri: Uri) {}
}

export class TabInputTextDiff {
  constructor(
    public readonly original: Uri,
    public readonly modified: Uri
  ) {}
}

export class TabInputCustom {
  constructor(
    public readonly uri: Uri,
    public readonly viewType: string
  ) {}
}

export class TabInputNotebook {
  constructor(
    public readonly uri: Uri,
    public readonly notebookType: string
  ) {}
}

export class TreeItem {
  id?: string
  description?: string | boolean
  tooltip?: string
  command?: Command
  contextValue?: string
  iconPath?: unknown
  resourceUri?: Uri
  public label?: string
  constructor(
    labelOrUri: string | Uri,
    public collapsibleState: number = TreeItemCollapsibleState.None
  ) {
    if (typeof labelOrUri === "string") this.label = labelOrUri
    else this.resourceUri = labelOrUri
  }
}

// ── Language models ─────────────────────────────────────────────────────

export class LanguageModelTextPart {
  constructor(public value: string) {}
}

export class LanguageModelToolCallPart {
  constructor(
    public callId: string,
    public name: string,
    public input: object
  ) {}
}

export class LanguageModelToolResultPart {
  constructor(
    public callId: string,
    public content: unknown[]
  ) {}
}

export const LanguageModelChatMessageRole = { User: 1, Assistant: 2 } as const

export class LanguageModelChatMessage {
  static User(content: string | unknown[], name?: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, content, name)
  }
  static Assistant(content: string | unknown[], name?: string): LanguageModelChatMessage {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, content, name)
  }
  public content: unknown[]
  constructor(
    public role: number,
    content: string | unknown[],
    public name?: string
  ) {
    this.content = typeof content === "string" ? [new LanguageModelTextPart(content)] : content
  }
}

export class LanguageModelError extends Error {
  static NoPermissions(message?: string): LanguageModelError {
    return new LanguageModelError(message ?? "No permissions", "NoPermissions")
  }
  static Blocked(message?: string): LanguageModelError {
    return new LanguageModelError(message ?? "Blocked", "Blocked")
  }
  static NotFound(message?: string): LanguageModelError {
    return new LanguageModelError(message ?? "Not found", "NotFound")
  }
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = "LanguageModelError"
  }
}
