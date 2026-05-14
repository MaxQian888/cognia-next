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

export class Uri {
  private constructor(
    public readonly scheme: string,
    public readonly authority: string,
    public readonly path: string,
    public readonly query: string,
    public readonly fragment: string
  ) {}
  static file(p: string): Uri {
    return new Uri("file", "", p, "", "")
  }
  static parse(value: string): Uri {
    const u = new URL(value)
    return new Uri(
      u.protocol.replace(/:$/, ""),
      u.host,
      u.pathname,
      u.search.replace(/^\?/, ""),
      u.hash.replace(/^#/, "")
    )
  }
  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path, ...segments]
      .map((s) => s.replace(/^\/+|\/+$/g, ""))
      .filter(Boolean)
      .join("/")
    return new Uri(base.scheme, base.authority, `/${joined}`, base.query, base.fragment)
  }
  get fsPath(): string {
    return this.path.replace(/^\/+/, this.scheme === "file" ? "/" : "")
  }
  toString(): string {
    const auth = this.authority ? `//${this.authority}` : ""
    const q = this.query ? `?${this.query}` : ""
    const f = this.fragment ? `#${this.fragment}` : ""
    return `${this.scheme}:${auth}${this.path}${q}${f}`
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
  public readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.push(listener)
    return new Disposable(() => {
      const idx = this.listeners.indexOf(listener)
      if (idx >= 0) this.listeners.splice(idx, 1)
    })
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
    onCancellationRequested: (listener) => this.emitter.event(listener),
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
  constructor(
    public readonly range: Range,
    public readonly newText: string
  ) {}
}

export class WorkspaceEdit {
  private edits = new Map<string, TextEdit[]>()
  set(uri: Uri, edits: TextEdit[]): void {
    this.edits.set(uri.toString(), edits.slice())
  }
  get(uri: Uri): TextEdit[] {
    return this.edits.get(uri.toString())?.slice() ?? []
  }
  entries(): Array<[Uri, TextEdit[]]> {
    return [...this.edits.entries()].map(([k, v]) => [Uri.parse(k), v.slice()])
  }
  has(uri: Uri): boolean {
    return this.edits.has(uri.toString())
  }
  delete(uri: Uri): void {
    this.edits.delete(uri.toString())
  }
  get size(): number {
    return this.edits.size
  }
}
