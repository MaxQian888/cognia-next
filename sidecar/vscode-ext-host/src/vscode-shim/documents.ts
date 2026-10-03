/**
 * The extension host's view of open documents and editors.
 *
 * The renderer owns the text (Monaco models); it reports every open, edit,
 * close and editor change, in order, through the requests below. This store
 * turns them into real `TextDocument` / `TextEditor` objects and the
 * `workspace` / `window` events extensions subscribe to. Providers are
 * called with these documents, and a provider call names the version it was
 * made against, so `waitForVersion` holds the call until the edit that
 * produced that version has arrived.
 */

import type { RpcConnection } from "../rpc"
import { EndOfLine } from "./api-types"
import { EventEmitter, Position, Range, Selection, Uri } from "./types"

export interface TextLine {
  readonly lineNumber: number
  readonly text: string
  readonly range: Range
  readonly rangeIncludingLineBreak: Range
  readonly firstNonWhitespaceCharacterIndex: number
  readonly isEmptyOrWhitespace: boolean
}

export interface TextDocumentContentChangeEvent {
  readonly range: Range
  readonly rangeOffset: number
  readonly rangeLength: number
  readonly text: string
}

export interface TextDocumentChangeEvent {
  readonly document: TextDocument
  readonly contentChanges: readonly TextDocumentContentChangeEvent[]
  readonly reason: undefined
}

/** VS Code's default word pattern, used when a language sets none. */
const DEFAULT_WORD_PATTERN = /(-?\d*\.\d\w*)|([^`~!@#$%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g

export class TextDocument {
  readonly uri: Uri
  private lines: string[] = [""]
  private lineStarts: number[] = [0]
  private content = ""
  private closed = false

  constructor(
    uri: string,
    private language: string,
    private documentVersion: number,
    text: string,
    private readonly save_: (document: TextDocument) => Promise<boolean>
  ) {
    this.uri = Uri.parse(uri)
    this.setText(text)
  }

  get fileName(): string {
    return this.uri.fsPath
  }
  get isUntitled(): boolean {
    return this.uri.scheme === "untitled"
  }
  get languageId(): string {
    return this.language
  }
  get version(): number {
    return this.documentVersion
  }
  /** The renderer saves on its own schedule; an open document is never reported dirty. */
  get isDirty(): boolean {
    return false
  }
  get isClosed(): boolean {
    return this.closed
  }
  get eol(): number {
    return this.content.includes("\r\n") ? EndOfLine.CRLF : EndOfLine.LF
  }
  get lineCount(): number {
    return this.lines.length
  }
  get encoding(): string {
    return "utf8"
  }

  save(): Promise<boolean> {
    return this.save_(this)
  }

  lineAt(lineOrPosition: number | Position): TextLine {
    const line = typeof lineOrPosition === "number" ? lineOrPosition : lineOrPosition.line
    if (!Number.isInteger(line) || line < 0 || line >= this.lines.length) {
      throw new RangeError(`Illegal value for \`line\`: ${line}`)
    }
    const text = this.lines[line]
    const firstNonWhitespace = text.search(/\S/)
    const nextStart = line + 1 < this.lineStarts.length ? this.lineStarts[line + 1] : undefined
    return {
      lineNumber: line,
      text,
      range: new Range(line, 0, line, text.length),
      rangeIncludingLineBreak:
        nextStart === undefined
          ? new Range(line, 0, line, text.length)
          : new Range(line, 0, line + 1, 0),
      firstNonWhitespaceCharacterIndex:
        firstNonWhitespace === -1 ? text.length : firstNonWhitespace,
      isEmptyOrWhitespace: firstNonWhitespace === -1,
    }
  }

  offsetAt(position: Position): number {
    const valid = this.validatePosition(position)
    return this.lineStarts[valid.line] + valid.character
  }

  positionAt(offset: number): Position {
    const clamped = Math.max(0, Math.min(Math.floor(offset), this.content.length))
    let low = 0
    let high = this.lineStarts.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (this.lineStarts[middle] <= clamped) low = middle
      else high = middle - 1
    }
    // An offset inside a CRLF pair belongs to the end of its line.
    return new Position(low, Math.min(clamped - this.lineStarts[low], this.lines[low].length))
  }

  getText(range?: Range): string {
    if (!range) return this.content
    const valid = this.validateRange(range)
    return this.content.slice(this.offsetAt(valid.start), this.offsetAt(valid.end))
  }

  getWordRangeAtPosition(position: Position, regex?: RegExp): Range | undefined {
    const valid = this.validatePosition(position)
    const text = this.lines[valid.line]
    const pattern = new RegExp((regex ?? DEFAULT_WORD_PATTERN).source, regexFlags(regex))
    for (const match of text.matchAll(pattern)) {
      const start = match.index ?? 0
      const end = start + match[0].length
      if (match[0].length > 0 && start <= valid.character && valid.character <= end) {
        return new Range(valid.line, start, valid.line, end)
      }
    }
    return undefined
  }

  validateRange(range: Range): Range {
    const start = this.validatePosition(range.start)
    const end = this.validatePosition(range.end)
    return start === range.start && end === range.end ? range : new Range(start, end)
  }

  validatePosition(position: Position): Position {
    if (position.line < 0) return new Position(0, 0)
    if (position.line >= this.lines.length) {
      const last = this.lines.length - 1
      return new Position(last, this.lines[last].length)
    }
    const length = this.lines[position.line].length
    if (position.character < 0) return new Position(position.line, 0)
    if (position.character > length) return new Position(position.line, length)
    return position
  }

  /** Replace the text, reporting the change as the one edit that spans the difference. */
  replaceText(text: string, version: number): TextDocumentContentChangeEvent | null {
    const previous = this.content
    this.documentVersion = version
    if (previous === text) return null
    let prefix = 0
    const shorter = Math.min(previous.length, text.length)
    while (prefix < shorter && previous.charCodeAt(prefix) === text.charCodeAt(prefix)) prefix += 1
    let suffix = 0
    while (
      suffix < shorter - prefix &&
      previous.charCodeAt(previous.length - 1 - suffix) ===
        text.charCodeAt(text.length - 1 - suffix)
    ) {
      suffix += 1
    }
    const range = new Range(this.positionAt(prefix), this.positionAt(previous.length - suffix))
    this.setText(text)
    return {
      range,
      rangeOffset: prefix,
      rangeLength: previous.length - suffix - prefix,
      text: text.slice(prefix, text.length - suffix),
    }
  }

  setLanguage(languageId: string): void {
    this.language = languageId
  }

  markClosed(): void {
    this.closed = true
  }

  private setText(text: string): void {
    this.content = text
    this.lines = text.split(/\r\n|\r|\n/)
    this.lineStarts = [0]
    const breaks = /\r\n|\r|\n/g
    for (const match of text.matchAll(breaks)) {
      this.lineStarts.push((match.index ?? 0) + match[0].length)
    }
  }
}

function regexFlags(regex: RegExp | undefined): string {
  const flags = regex?.flags ?? DEFAULT_WORD_PATTERN.flags
  return flags.includes("g") ? flags : `${flags}g`
}

interface WireSelection {
  anchor: { line: number; character: number }
  active: { line: number; character: number }
}

export interface WireEditor {
  id: string
  uri: string
  selections: WireSelection[]
  visibleRanges?: WireEdit["range"][]
  options?: Partial<EditorOptions>
}

/** One text change an editor operation makes, in the document's coordinates. */
export interface WireEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  text: string
}

/**
 * What a `TextEditor` asks of the renderer, which owns the real editor.
 * Implemented by the host over its connection.
 */
export interface EditorOperations {
  /** Apply `edits` if the document is still at `version`; `false` when it moved on. */
  edit(
    editorId: string,
    version: number,
    edits: WireEdit[],
    options: { undoStopBefore: boolean; undoStopAfter: boolean; endOfLine?: number }
  ): Promise<boolean>
  insertSnippet(
    editorId: string,
    version: number,
    snippet: string,
    ranges: WireEdit["range"][],
    options: { undoStopBefore: boolean; undoStopAfter: boolean }
  ): Promise<boolean>
  setDecorations(editorId: string, key: string, decorations: unknown[]): void
  revealRange(editorId: string, range: WireEdit["range"], revealType: number): void
  setSelections(editorId: string, selections: WireSelection[]): void
  setOptions(editorId: string, options: Partial<EditorOptions>): void
}

export interface EditorOptions {
  tabSize: number
  insertSpaces: boolean
  cursorStyle: number
  lineNumbers: number
}

const DEFAULT_EDITOR_OPTIONS: EditorOptions = {
  tabSize: 4,
  insertSpaces: true,
  cursorStyle: 1,
  lineNumbers: 1,
}

function wireRangeOf(range: Range): WireEdit["range"] {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  }
}

function wireSelectionOf(selection: Selection): WireSelection {
  return {
    anchor: { line: selection.anchor.line, character: selection.anchor.character },
    active: { line: selection.active.line, character: selection.active.character },
  }
}

/**
 * The builder `TextEditor.edit` hands its callback. Edits are collected and
 * sent together; like VS Code, overlapping ranges are refused.
 */
class TextEditorEdit {
  readonly edits: Array<{ range: Range; text: string }> = []
  endOfLine: number | undefined

  constructor(private readonly document: TextDocument) {}

  replace(location: Position | Range, value: string): void {
    const range = location instanceof Position ? new Range(location, location) : location
    this.edits.push({ range: this.document.validateRange(range), text: value })
  }

  insert(location: Position, value: string): void {
    const at = this.document.validatePosition(location)
    this.edits.push({ range: new Range(at, at), text: value })
  }

  delete(location: Range): void {
    this.edits.push({ range: this.document.validateRange(location), text: "" })
  }

  setEndOfLine(endOfLine: number): void {
    this.endOfLine = endOfLine
  }

  checked(): WireEdit[] {
    const sorted = [...this.edits].sort((a, b) => a.range.start.compareTo(b.range.start))
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1].range
      const current = sorted[index].range
      if (current.start.isBefore(previous.end)) {
        throw new Error("Overlapping ranges are not allowed!")
      }
    }
    return this.edits.map((edit) => ({ range: wireRangeOf(edit.range), text: edit.text }))
  }
}

export class TextEditor {
  private selectionList: Selection[]
  private visible: Range[] | undefined
  private optionValues: EditorOptions

  constructor(
    readonly id: string,
    readonly document: TextDocument,
    selections: Selection[],
    private readonly operations?: EditorOperations,
    visibleRanges?: Range[],
    options?: Partial<EditorOptions>
  ) {
    this.selectionList = selections
    this.visible = visibleRanges
    this.optionValues = { ...DEFAULT_EDITOR_OPTIONS, ...options }
  }

  get selections(): Selection[] {
    return this.selectionList
  }
  /** Setting moves the editor's cursors, as in VS Code. */
  set selections(value: Selection[]) {
    this.selectionList = value
    this.operations?.setSelections(this.id, value.map(wireSelectionOf))
  }

  get selection(): Selection {
    return this.selectionList[0] ?? new Selection(new Position(0, 0), new Position(0, 0))
  }
  set selection(value: Selection) {
    this.selections = [value, ...this.selectionList.slice(1)]
  }

  /** Reported by the renderer; the whole document until it reports otherwise. */
  get visibleRanges(): Range[] {
    return this.visible ?? [new Range(0, 0, Math.max(0, this.document.lineCount - 1), 0)]
  }

  get options(): EditorOptions {
    const editor = this
    return new Proxy(this.optionValues, {
      set(target, field, value) {
        ;(target as unknown as Record<string | symbol, unknown>)[field] = value
        editor.operations?.setOptions(editor.id, { [field]: value } as Partial<EditorOptions>)
        return true
      },
    })
  }
  set options(value: Partial<EditorOptions>) {
    this.optionValues = { ...this.optionValues, ...value }
    this.operations?.setOptions(this.id, value)
  }

  get viewColumn(): number | undefined {
    return 1
  }

  /** Updated from the renderer's report, without echoing it back. */
  applyReport(
    selections: Selection[],
    visibleRanges?: Range[],
    options?: Partial<EditorOptions>
  ): void {
    this.selectionList = selections
    if (visibleRanges) this.visible = visibleRanges
    if (options) this.optionValues = { ...this.optionValues, ...options }
  }

  async edit(
    callback: (builder: TextEditorEdit) => void,
    options: { undoStopBefore?: boolean; undoStopAfter?: boolean } = {}
  ): Promise<boolean> {
    if (this.document.isClosed || !this.operations) return false
    const builder = new TextEditorEdit(this.document)
    callback(builder)
    const edits = builder.checked()
    if (edits.length === 0 && builder.endOfLine === undefined) return true
    return this.operations.edit(this.id, this.document.version, edits, {
      undoStopBefore: options.undoStopBefore ?? true,
      undoStopAfter: options.undoStopAfter ?? true,
      ...(builder.endOfLine !== undefined ? { endOfLine: builder.endOfLine } : {}),
    })
  }

  async insertSnippet(
    snippet: { value: string },
    location?: Position | Range | readonly Position[] | readonly Range[],
    options: { undoStopBefore?: boolean; undoStopAfter?: boolean } = {}
  ): Promise<boolean> {
    if (this.document.isClosed || !this.operations) return false
    const toRange = (at: Position | Range) => (at instanceof Position ? new Range(at, at) : at)
    const ranges =
      location === undefined
        ? this.selectionList.map((selection) => new Range(selection.start, selection.end))
        : Array.isArray(location)
          ? (location as Array<Position | Range>).map(toRange)
          : [toRange(location as Position | Range)]
    return this.operations.insertSnippet(
      this.id,
      this.document.version,
      snippet.value,
      ranges.map(wireRangeOf),
      {
        undoStopBefore: options.undoStopBefore ?? true,
        undoStopAfter: options.undoStopAfter ?? true,
      }
    )
  }

  /** `ranges` are `Range`s or `DecorationOptions` (`{range, hoverMessage, renderOptions}`). */
  setDecorations(
    decorationType: { key: string },
    ranges: ReadonlyArray<Range | { range: Range; hoverMessage?: unknown; renderOptions?: unknown }>
  ): void {
    this.operations?.setDecorations(
      this.id,
      decorationType.key,
      ranges.map((entry) =>
        entry instanceof Range
          ? { range: wireRangeOf(entry) }
          : {
              range: wireRangeOf(entry.range),
              ...(entry.hoverMessage !== undefined
                ? { hoverMessage: hoverText(entry.hoverMessage) }
                : {}),
              ...(entry.renderOptions !== undefined ? { renderOptions: entry.renderOptions } : {}),
            }
      )
    )
  }

  revealRange(range: Range, revealType = 0): void {
    this.operations?.revealRange(this.id, wireRangeOf(range), revealType)
  }

  /** Deprecated in VS Code; kept so old extensions do not throw. */
  show(): void {}
  hide(): void {}
}

/** A hover message (string, `MarkdownString` or a list of them) as Markdown text. */
function hoverText(message: unknown): string {
  const one = (value: unknown) =>
    typeof value === "string"
      ? value
      : typeof value === "object" &&
          value !== null &&
          typeof (value as { value?: unknown }).value === "string"
        ? (value as { value: string }).value
        : String(value)
  return Array.isArray(message) ? message.map(one).join("\n\n") : one(message)
}

function toSelection(wire: WireSelection): Selection {
  return new Selection(
    new Position(wire.anchor.line, wire.anchor.character),
    new Position(wire.active.line, wire.active.character)
  )
}

/** How long a provider call waits for the edit it was made against. */
export const VERSION_WAIT_MS = 2_000

export class DocumentStore {
  private readonly documents = new Map<string, TextDocument>()
  private readonly editors = new Map<string, TextEditor>()
  private activeEditorId: string | null = null
  private readonly versionWaiters = new Set<() => void>()

  readonly onDidOpen = new EventEmitter<TextDocument>()
  readonly onDidChange = new EventEmitter<TextDocumentChangeEvent>()
  readonly onDidClose = new EventEmitter<TextDocument>()
  readonly onDidSave = new EventEmitter<TextDocument>()
  readonly onDidChangeActiveEditor = new EventEmitter<TextEditor | undefined>()
  readonly onDidChangeVisibleEditors = new EventEmitter<readonly TextEditor[]>()
  readonly onDidChangeSelection = new EventEmitter<{
    textEditor: TextEditor
    selections: readonly Selection[]
    kind: undefined
  }>()

  readonly onDidChangeVisibleRanges = new EventEmitter<{
    textEditor: TextEditor
    visibleRanges: readonly Range[]
  }>()
  readonly onDidChangeOptions = new EventEmitter<{
    textEditor: TextEditor
    options: EditorOptions
  }>()

  constructor(
    private readonly save: (document: TextDocument) => Promise<boolean>,
    private readonly operations?: EditorOperations
  ) {}

  /** Answer the renderer's document and editor reports on `connection`. */
  attach(connection: RpcConnection): void {
    connection.onRequest("workspace:documentOpened", (params) => {
      const { uri, languageId, version, text } = params as {
        uri: string
        languageId: string
        version: number
        text: string
      }
      this.open(uri, languageId, version, text)
      return null
    })
    connection.onRequest("workspace:documentChanged", (params) => {
      const { uri, version, text } = params as { uri: string; version: number; text: string }
      this.change(uri, version, text)
      return null
    })
    connection.onRequest("workspace:documentLanguageChanged", (params) => {
      const { uri, languageId } = params as { uri: string; languageId: string }
      this.setLanguage(uri, languageId)
      return null
    })
    connection.onRequest("workspace:documentSaved", (params) => {
      const document = this.documents.get((params as { uri: string }).uri)
      if (document) this.onDidSave.fire(document)
      return null
    })
    connection.onRequest("workspace:documentClosed", (params) => {
      this.close((params as { uri: string }).uri)
      return null
    })
    connection.onRequest("window:editorsChanged", (params) => {
      const { editors, activeId } = params as { editors: WireEditor[]; activeId: string | null }
      this.setEditors(editors, activeId)
      return null
    })
  }

  open(uri: string, languageId: string, version: number, text: string): TextDocument {
    const existing = this.documents.get(uri)
    if (existing) {
      this.change(uri, version, text)
      return existing
    }
    const document = new TextDocument(uri, languageId, version, text, this.save)
    this.documents.set(uri, document)
    this.onDidOpen.fire(document)
    this.notifyVersion()
    return document
  }

  change(uri: string, version: number, text: string): void {
    const document = this.documents.get(uri)
    if (!document || version < document.version) return
    const change = document.replaceText(text, version)
    if (change) this.onDidChange.fire({ document, contentChanges: [change], reason: undefined })
    this.notifyVersion()
  }

  /** VS Code reports a language change as the document closing and reopening. */
  setLanguage(uri: string, languageId: string): void {
    const document = this.documents.get(uri)
    if (!document || document.languageId === languageId) return
    this.onDidClose.fire(document)
    document.setLanguage(languageId)
    this.onDidOpen.fire(document)
  }

  close(uri: string): void {
    const document = this.documents.get(uri)
    if (!document) return
    this.documents.delete(uri)
    document.markClosed()
    this.onDidClose.fire(document)
    this.notifyVersion()
  }

  get(uri: string): TextDocument | undefined {
    return this.documents.get(uri)
  }

  all(): TextDocument[] {
    return [...this.documents.values()]
  }

  get activeEditor(): TextEditor | undefined {
    return this.activeEditorId ? this.editors.get(this.activeEditorId) : undefined
  }

  get visibleEditors(): TextEditor[] {
    return [...this.editors.values()]
  }

  setEditors(wire: WireEditor[], activeId: string | null): void {
    const previousActive = this.activeEditor
    const previousIds = [...this.editors.keys()].join("\n")
    const next = new Map<string, TextEditor>()
    const selectionChanges: TextEditor[] = []
    const rangeChanges: TextEditor[] = []
    const optionChanges: TextEditor[] = []
    for (const entry of wire) {
      const document = this.documents.get(entry.uri)
      if (!document) continue
      const selections = entry.selections.map(toSelection)
      const visibleRanges = entry.visibleRanges?.map(
        (range) =>
          new Range(range.start.line, range.start.character, range.end.line, range.end.character)
      )
      const existing = this.editors.get(entry.id)
      if (existing && existing.document === document) {
        const changed =
          existing.selections.length !== selections.length ||
          existing.selections.some((selection, index) => !selection.isEqual(selections[index]))
        const rangesChanged =
          visibleRanges !== undefined &&
          (existing.visibleRanges.length !== visibleRanges.length ||
            existing.visibleRanges.some((range, index) => !range.isEqual(visibleRanges[index])))
        const optionsChanged =
          entry.options !== undefined &&
          Object.entries(entry.options).some(
            ([field, value]) =>
              (existing.options as unknown as Record<string, unknown>)[field] !== value
          )
        existing.applyReport(selections, visibleRanges, entry.options)
        next.set(entry.id, existing)
        if (changed) selectionChanges.push(existing)
        if (rangesChanged) rangeChanges.push(existing)
        if (optionsChanged) optionChanges.push(existing)
      } else {
        next.set(
          entry.id,
          new TextEditor(
            entry.id,
            document,
            selections,
            this.operations,
            visibleRanges,
            entry.options
          )
        )
      }
    }
    this.editors.clear()
    for (const [id, editor] of next) this.editors.set(id, editor)
    this.activeEditorId = activeId && next.has(activeId) ? activeId : null

    if ([...next.keys()].join("\n") !== previousIds) {
      this.onDidChangeVisibleEditors.fire(this.visibleEditors)
    }
    if (this.activeEditor !== previousActive) {
      this.onDidChangeActiveEditor.fire(this.activeEditor)
    }
    for (const editor of selectionChanges) {
      this.onDidChangeSelection.fire({
        textEditor: editor,
        selections: editor.selections,
        kind: undefined,
      })
    }
    for (const editor of rangeChanges) {
      this.onDidChangeVisibleRanges.fire({
        textEditor: editor,
        visibleRanges: editor.visibleRanges,
      })
    }
    for (const editor of optionChanges) {
      this.onDidChangeOptions.fire({ textEditor: editor, options: editor.options })
    }
  }

  /**
   * The document at `uri` once it has reached `version`. A call made against
   * an edit (or an open) still in flight waits for it, up to
   * {@link VERSION_WAIT_MS}; after that the provider runs against the newest
   * text there is, or gets no document. Without a version, only a document
   * open now counts.
   */
  async waitForVersion(
    uri: string,
    version: number | undefined
  ): Promise<TextDocument | undefined> {
    const ready = () => {
      const document = this.documents.get(uri)
      return document && (version === undefined || document.version >= version) ? document : null
    }
    const now = ready()
    if (now) return now
    // A call that names no version is about a document open now, or none.
    if (version === undefined) return undefined
    return new Promise((resolve) => {
      const check = () => {
        const document = ready()
        if (document) finish(document)
      }
      const finish = (document: TextDocument | undefined) => {
        clearTimeout(timer)
        this.versionWaiters.delete(check)
        resolve(document)
      }
      const timer = setTimeout(() => finish(this.documents.get(uri)), VERSION_WAIT_MS)
      this.versionWaiters.add(check)
    })
  }

  private notifyVersion(): void {
    for (const waiter of [...this.versionWaiters]) waiter()
  }
}
