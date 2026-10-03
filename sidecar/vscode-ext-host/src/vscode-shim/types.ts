/**
 * Shared types for the sidecar's `vscode` shim.
 *
 * These mirror VS Code's public surface verbatim where it matters
 * (constructor shapes, method signatures, enum values). cognia consumers
 * never import this module — extensions get the shim via `require("vscode")`.
 */

export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number
  ) {}
  isBefore(other: Position): boolean {
    if (this.line < other.line) return true
    if (this.line > other.line) return false
    return this.character < other.character
  }
  isAfter(other: Position): boolean {
    return other.isBefore(this)
  }
  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character
  }
  compareTo(other: Position): number {
    if (this.line !== other.line) return this.line - other.line
    return this.character - other.character
  }
  translate(lineDelta = 0, characterDelta = 0): Position {
    return new Position(this.line + lineDelta, this.character + characterDelta)
  }
  with(line?: number, character?: number): Position {
    return new Position(line ?? this.line, character ?? this.character)
  }
}

export class Range {
  public readonly start: Position
  public readonly end: Position
  constructor(start: Position | number, end: Position | number, c?: number, d?: number) {
    if (start instanceof Position && end instanceof Position) {
      this.start = start.isBefore(end) ? start : end
      this.end = start.isBefore(end) ? end : start
    } else if (
      typeof start === "number" &&
      typeof end === "number" &&
      typeof c === "number" &&
      typeof d === "number"
    ) {
      const a = new Position(start, end)
      const b = new Position(c, d)
      this.start = a.isBefore(b) ? a : b
      this.end = a.isBefore(b) ? b : a
    } else {
      throw new TypeError("Invalid Range constructor arguments")
    }
  }
  isEmpty(): boolean {
    return this.start.isEqual(this.end)
  }
  isSingleLine(): boolean {
    return this.start.line === this.end.line
  }
  contains(position: Position | Range): boolean {
    if (position instanceof Position) {
      return !position.isBefore(this.start) && !this.end.isBefore(position)
    }
    return this.contains(position.start) && this.contains(position.end)
  }
  isEqual(other: Range): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end)
  }
  intersection(other: Range): Range | undefined {
    const start = this.start.isAfter(other.start) ? this.start : other.start
    const end = this.end.isBefore(other.end) ? this.end : other.end
    return start.isAfter(end) ? undefined : new Range(start, end)
  }
  union(other: Range): Range {
    return new Range(
      this.start.isBefore(other.start) ? this.start : other.start,
      this.end.isAfter(other.end) ? this.end : other.end
    )
  }
  with(start?: Position | { start?: Position; end?: Position }, end?: Position): Range {
    if (start && !(start instanceof Position)) {
      return new Range(start.start ?? this.start, start.end ?? this.end)
    }
    return new Range(start ?? this.start, end ?? this.end)
  }
}

export class Selection extends Range {
  public readonly anchor: Position
  public readonly active: Position
  public readonly isReversed: boolean
  constructor(anchor: Position, active: Position) {
    super(anchor, active)
    this.anchor = anchor
    this.active = active
    this.isReversed = active.isBefore(anchor)
  }
}

/**
 * VS Code's `Uri`. `path` is decoded (a space is a space); `toString()`
 * percent-encodes it, so `Uri.file("/a b").toString()` is `file:///a%20b`
 * and `Uri.parse` of that gives back the same path.
 *
 * Serialization: `toJSON()` returns the string form. Every value crossing
 * the sidecar's JSON-RPC wire is JSON, and the renderer reads URIs as
 * strings, so a `Diagnostic` or `Location` arrives with a usable `uri`
 * rather than a bag of components. `Uri.revive` accepts either form.
 */
export class Uri {
  private constructor(
    public readonly scheme: string,
    public readonly authority: string,
    public readonly path: string,
    public readonly query: string,
    public readonly fragment: string
  ) {}
  static file(p: string): Uri {
    let path = p.replace(/\\/g, "/")
    if (/^[a-zA-Z]:/.test(path)) path = `/${path}`
    if (!path.startsWith("/")) path = `/${path}`
    return new Uri("file", "", path, "", "")
  }
  static parse(value: string): Uri {
    const match = /^([a-zA-Z][\w+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(
      value
    )
    if (!match) throw new Error(`[UriError]: ${value} is not a URI`)
    const [, scheme, authority = "", path = "", query = "", fragment = ""] = match
    return new Uri(
      scheme.toLowerCase(),
      decodeLenient(authority),
      decodeLenient(path),
      decodeLenient(query),
      decodeLenient(fragment)
    )
  }
  static from(components: {
    scheme: string
    authority?: string
    path?: string
    query?: string
    fragment?: string
  }): Uri {
    return new Uri(
      components.scheme,
      components.authority ?? "",
      components.path ?? "",
      components.query ?? "",
      components.fragment ?? ""
    )
  }
  /** A string, a `Uri`, or URI components (as JSON from elsewhere) → `Uri`. */
  static revive(value: unknown): Uri | undefined {
    if (value instanceof Uri) return value
    if (typeof value === "string") return Uri.parse(value)
    if (
      value &&
      typeof value === "object" &&
      typeof (value as { scheme?: unknown }).scheme === "string"
    ) {
      return Uri.from(value as { scheme: string })
    }
    return undefined
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path, ...segments]
      .join("/")
      .split("/")
      .reduce<string[]>((parts, part) => {
        if (part === "" || part === ".") return parts
        if (part === "..") parts.pop()
        else parts.push(part)
        return parts
      }, [])
      .join("/")
    return new Uri(base.scheme, base.authority, `/${joined}`, base.query, base.fragment)
  }
  static isUri(value: unknown): value is Uri {
    return value instanceof Uri
  }
  get fsPath(): string {
    if (this.authority && this.scheme === "file") return `//${this.authority}${this.path}`
    if (/^\/[a-zA-Z]:/.test(this.path)) return this.path.slice(1)
    return this.path
  }
  toString(skipEncoding = false): string {
    const encode = skipEncoding ? (text: string) => text : encodePath
    const authority = this.authority || this.scheme === "file" ? `//${this.authority}` : ""
    const query = this.query ? `?${skipEncoding ? this.query : encodeURIComponent(this.query)}` : ""
    const fragment = this.fragment
      ? `#${skipEncoding ? this.fragment : encodeURIComponent(this.fragment)}`
      : ""
    return `${this.scheme}:${authority}${encode(this.path)}${query}${fragment}`
  }
  toJSON(): string {
    return this.toString()
  }
  with(
    change: Partial<{
      scheme: string
      authority: string
      path: string
      query: string
      fragment: string
    }>
  ): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment
    )
  }
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ":"))
    .join("/")
}

function decodeLenient(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

export class Disposable {
  static from(...items: Array<{ dispose(): unknown }>): Disposable {
    return new Disposable(() => {
      for (const item of items) {
        try {
          item.dispose()
        } catch {
          /* swallow */
        }
      }
    })
  }
  constructor(private readonly fn: () => void) {}
  dispose(): void {
    try {
      this.fn()
    } catch {
      /* swallow */
    }
  }
}

export class EventEmitter<T> {
  private listeners: Array<(value: T) => void> = []
  /** VS Code's `Event<T>`: `listener` runs with `thisArgs`, and the subscription joins `disposables`. */
  public readonly event = (
    listener: (value: T) => void,
    thisArgs?: unknown,
    disposables?: Array<{ dispose(): unknown }>
  ): Disposable => {
    const bound = thisArgs === undefined ? listener : (value: T) => listener.call(thisArgs, value)
    this.listeners.push(bound)
    const subscription = new Disposable(() => {
      const idx = this.listeners.indexOf(bound)
      if (idx >= 0) this.listeners.splice(idx, 1)
    })
    if (Array.isArray(disposables)) disposables.push(subscription)
    return subscription
  }
  fire(value: T): void {
    for (const listener of this.listeners.slice()) {
      try {
        listener(value)
      } catch {
        /* swallow */
      }
    }
  }
  dispose(): void {
    this.listeners.length = 0
  }
}

export interface CancellationToken {
  readonly isCancellationRequested: boolean
  onCancellationRequested(listener: () => void): Disposable
}

export class CancellationTokenSource {
  private cancelled = false
  private emitter = new EventEmitter<void>()
  readonly token: CancellationToken = {
    get isCancellationRequested(): boolean {
      return false
    },
    // As in VS Code, a listener added after cancellation still runs (soon).
    onCancellationRequested: (listener) => {
      if (!this.cancelled) return this.emitter.event(listener)
      const timer = setTimeout(listener, 0)
      return new Disposable(() => clearTimeout(timer))
    },
  }
  constructor() {
    Object.defineProperty(this.token, "isCancellationRequested", {
      get: () => this.cancelled,
    })
  }
  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    this.emitter.fire(undefined)
  }
  dispose(): void {
    this.emitter.dispose()
  }
}

export class NotSupportedError extends Error {
  constructor(api: string) {
    super(
      `vscode.${api} is not supported in cognia. See the VS Code reuse plan: ~/.claude/plans/vscode-snug-squid.md`
    )
    this.name = "NotSupportedError"
  }
}

export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
} as const

export const TextDocumentSaveReason = {
  Manual: 1,
  AfterDelay: 2,
  FocusOut: 3,
} as const

export const StatusBarAlignment = {
  Left: 1,
  Right: 2,
} as const

export const ViewColumn = {
  Active: -1,
  Beside: -2,
  One: 1,
  Two: 2,
  Three: 3,
  Four: 4,
  Five: 5,
  Six: 6,
  Seven: 7,
  Eight: 8,
  Nine: 9,
} as const

export const DiagnosticSeverity = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
} as const

export const CompletionItemKind = {
  Text: 0,
  Method: 1,
  Function: 2,
  Constructor: 3,
  Field: 4,
  Variable: 5,
  Class: 6,
  Interface: 7,
  Module: 8,
  Property: 9,
  Unit: 10,
  Value: 11,
  Enum: 12,
  Keyword: 13,
  Snippet: 14,
  Color: 15,
  File: 16,
  Reference: 17,
  Folder: 18,
  EnumMember: 19,
  Constant: 20,
  Struct: 21,
  Event: 22,
  Operator: 23,
  TypeParameter: 24,
  User: 25,
  Issue: 26,
} as const

export class MarkdownString {
  public value = ""
  public isTrusted = false
  public supportThemeIcons = false
  constructor(value = "", supportThemeIcons = false) {
    this.value = value
    this.supportThemeIcons = supportThemeIcons
  }
  appendText(value: string): MarkdownString {
    this.value += value
    return this
  }
  appendMarkdown(value: string): MarkdownString {
    this.value += value
    return this
  }
  appendCodeblock(value: string, language?: string): MarkdownString {
    this.value += `\n\`\`\`${language ?? ""}\n${value}\n\`\`\`\n`
    return this
  }
}

export class TextEdit {
  static replace(range: Range, newText: string): TextEdit {
    return new TextEdit(range, newText)
  }
  static insert(position: Position, newText: string): TextEdit {
    return new TextEdit(new Range(position, position), newText)
  }
  static delete(range: Range): TextEdit {
    return new TextEdit(range, "")
  }
  static setEndOfLine(eol: number): TextEdit {
    const edit = new TextEdit(new Range(new Position(0, 0), new Position(0, 0)), "")
    edit.newEol = eol
    return edit
  }
  newEol?: number
  constructor(
    public range: Range,
    public newText: string
  ) {}
}

/** One file operation recorded in a {@link WorkspaceEdit}. */
export type WorkspaceFileOperation =
  | {
      kind: "create"
      uri: Uri
      options?: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: Uint8Array }
    }
  | {
      kind: "rename"
      oldUri: Uri
      newUri: Uri
      options?: { overwrite?: boolean; ignoreIfExists?: boolean }
    }
  | { kind: "delete"; uri: Uri; options?: { recursive?: boolean; ignoreIfNotExists?: boolean } }

type WorkspaceEditEntry = { kind: "edit"; uri: string; edit: TextEdit } | WorkspaceFileOperation

/** One step of a {@link WorkspaceEdit} as the renderer applies it, in order. */
export type WireWorkspaceEditOperation =
  | {
      kind: "edit"
      uri: string
      edits: Array<{ range: Range; newText: string }>
      /** `EndOfLine` (1 LF, 2 CRLF) when a `TextEdit.setEndOfLine` asked for one. */
      eol?: number
    }
  | {
      kind: "create"
      uri: string
      options?: { overwrite?: boolean; ignoreIfExists?: boolean }
      /** The new file's text; `binary` when the contents are not UTF-8. */
      contents?: { text: string } | { binary: true }
    }
  | {
      kind: "rename"
      oldUri: string
      newUri: string
      options?: { overwrite?: boolean; ignoreIfExists?: boolean }
    }
  | {
      kind: "delete"
      uri: string
      options?: { recursive?: boolean; ignoreIfNotExists?: boolean }
    }

/**
 * Text edits and file operations, kept in the order they were added: VS
 * Code applies a workspace edit in that order, so an edit to a file it
 * creates comes after the create.
 */
export class WorkspaceEdit {
  private entriesInOrder: WorkspaceEditEntry[] = []
  set(uri: Uri, edits: ReadonlyArray<TextEdit | [TextEdit, unknown]> | null | undefined): void {
    const key = uri.toString()
    this.entriesInOrder = this.entriesInOrder.filter(
      (entry) => !(entry.kind === "edit" && entry.uri === key)
    )
    for (const edit of edits ?? []) {
      this.entriesInOrder.push({
        kind: "edit",
        uri: key,
        edit: Array.isArray(edit) ? edit[0] : edit,
      })
    }
  }
  get(uri: Uri): TextEdit[] {
    const key = uri.toString()
    return this.textEntries()
      .filter((entry) => entry.uri === key)
      .map((entry) => entry.edit)
  }
  replace(uri: Uri, range: Range, newText: string): void {
    this.push(uri, TextEdit.replace(range, newText))
  }
  insert(uri: Uri, position: Position, newText: string): void {
    this.push(uri, TextEdit.insert(position, newText))
  }
  delete(uri: Uri, range?: Range): void {
    if (range) this.push(uri, TextEdit.delete(range))
    else this.set(uri, [])
  }
  createFile(
    uri: Uri,
    options?: { overwrite?: boolean; ignoreIfExists?: boolean; contents?: Uint8Array }
  ): void {
    this.entriesInOrder.push({ kind: "create", uri, options })
  }
  renameFile(
    oldUri: Uri,
    newUri: Uri,
    options?: { overwrite?: boolean; ignoreIfExists?: boolean }
  ): void {
    this.entriesInOrder.push({ kind: "rename", oldUri, newUri, options })
  }
  deleteFile(uri: Uri, options?: { recursive?: boolean; ignoreIfNotExists?: boolean }): void {
    this.entriesInOrder.push({ kind: "delete", uri, options })
  }
  /** The file operations, in the order they were added. */
  get fileOperations(): WorkspaceFileOperation[] {
    return this.entriesInOrder.filter(
      (entry): entry is WorkspaceFileOperation => entry.kind !== "edit"
    )
  }
  entries(): Array<[Uri, TextEdit[]]> {
    const grouped = new Map<string, TextEdit[]>()
    for (const entry of this.textEntries()) {
      grouped.set(entry.uri, [...(grouped.get(entry.uri) ?? []), entry.edit])
    }
    return [...grouped].map(([key, edits]) => [Uri.parse(key), edits])
  }
  has(uri: Uri): boolean {
    const key = uri.toString()
    return this.textEntries().some((entry) => entry.uri === key)
  }
  get size(): number {
    return this.entries().length + this.fileOperations.length
  }
  private textEntries(): Array<{ kind: "edit"; uri: string; edit: TextEdit }> {
    return this.entriesInOrder.filter(
      (entry): entry is { kind: "edit"; uri: string; edit: TextEdit } => entry.kind === "edit"
    )
  }
  private push(uri: Uri, edit: TextEdit): void {
    this.entriesInOrder.push({ kind: "edit", uri: uri.toString(), edit })
  }
  /**
   * The steps the renderer applies, in order: consecutive text edits to one
   * document travel together, and file operations sit between them where
   * they were added.
   */
  toJSON(): { operations: WireWorkspaceEditOperation[] } {
    const operations: WireWorkspaceEditOperation[] = []
    for (const entry of this.entriesInOrder) {
      if (entry.kind === "edit") {
        const last = operations[operations.length - 1]
        const step =
          last?.kind === "edit" && last.uri === entry.uri
            ? last
            : (operations[
                operations.push({ kind: "edit", uri: entry.uri, edits: [] }) - 1
              ] as Extract<WireWorkspaceEditOperation, { kind: "edit" }>)
        if (entry.edit.newEol !== undefined) step.eol = entry.edit.newEol
        else step.edits.push({ range: entry.edit.range, newText: entry.edit.newText })
      } else if (entry.kind === "create") {
        const { contents, ...options } = entry.options ?? {}
        operations.push({
          kind: "create",
          uri: entry.uri.toString(),
          ...(entry.options ? { options } : {}),
          ...(contents ? { contents: wireContents(contents) } : {}),
        })
      } else if (entry.kind === "rename") {
        operations.push({
          kind: "rename",
          oldUri: entry.oldUri.toString(),
          newUri: entry.newUri.toString(),
          ...(entry.options ? { options: entry.options } : {}),
        })
      } else {
        operations.push({
          kind: "delete",
          uri: entry.uri.toString(),
          ...(entry.options ? { options: entry.options } : {}),
        })
      }
    }
    return { operations }
  }
}

/** File contents as text, or marked binary when they are not UTF-8. */
export function wireContents(contents: Uint8Array): { text: string } | { binary: true } {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(contents) }
  } catch {
    return { binary: true }
  }
}
