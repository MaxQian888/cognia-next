/**
 * The value types of the areas `api-types.ts` leaves out: tasks, terminal
 * links and profiles, drag-and-drop data, notebooks, debugging, comments,
 * testing and coverage, the remaining tab inputs, telemetry and chat
 * history.
 *
 * An extension constructs these whether or not Cognia acts on them (a test
 * extension builds `TestMessage`s, a language extension declares a `Task`),
 * so each one exists with the constructor, defaults and validation of
 * `vscode.d.ts` (API 1.91) and VS Code's own implementation. Whether the
 * namespace that consumes one does anything with it is recorded in
 * `unsupported.ts`, not here.
 */

import { randomUUID } from "node:crypto"

import { MarkdownString, Position, Range, Uri, WorkspaceEdit } from "./types"
import { Location, NotebookCellKind, SnippetString, ThemeColor } from "./api-types"
import type { Command } from "./api-types"

function illegalArgument(name: string): Error {
  return new Error(`Illegal argument: ${name}`)
}

// ── Editor and terminal ─────────────────────────────────────────────────

export const TextEditorCursorStyle = {
  Line: 1,
  Block: 2,
  Underline: 3,
  LineThin: 4,
  BlockOutline: 5,
  UnderlineThin: 6,
} as const
export const TextEditorLineNumbersStyle = { Off: 0, On: 1, Relative: 2, Interval: 3 } as const
export const SyntaxTokenType = { Other: 0, Comment: 1, String: 2, RegEx: 3 } as const
export const TreeItemCheckboxState = { Unchecked: 0, Checked: 1 } as const

export class DocumentDropEdit {
  additionalEdit?: WorkspaceEdit
  constructor(public insertText: string | SnippetString) {}
}

export class TerminalLink {
  constructor(
    public startIndex: number,
    public length: number,
    public tooltip?: string
  ) {
    if (typeof startIndex !== "number") throw new TypeError("startIndex")
    if (typeof length !== "number") throw new TypeError("length")
    if (tooltip !== undefined && typeof tooltip !== "string") throw new TypeError("tooltip")
  }
}

export class TerminalProfile {
  constructor(public options: Record<string, unknown>) {
    if (typeof options !== "object" || options === null) throw illegalArgument("options")
  }
}

export class FileDecoration {
  propagate?: boolean
  constructor(
    public badge?: string,
    public tooltip?: string,
    public color?: ThemeColor
  ) {}
}

// ── Tasks ───────────────────────────────────────────────────────────────

export const ShellQuoting = { Escape: 1, Strong: 2, Weak: 3 } as const

export class TaskGroup {
  static readonly Clean = new TaskGroup("clean", "Clean")
  static readonly Build = new TaskGroup("build", "Build")
  static readonly Rebuild = new TaskGroup("rebuild", "Rebuild")
  static readonly Test = new TaskGroup("test", "Test")

  isDefault: boolean | undefined
  constructor(
    public readonly id: string,
    public readonly label: string
  ) {
    if (typeof id !== "string") throw illegalArgument("id")
    if (typeof label !== "string") throw illegalArgument("label")
  }
}

export interface ProcessExecutionOptions {
  cwd?: string
  env?: Record<string, string>
}

export class ProcessExecution {
  process: string
  args: string[]
  options?: ProcessExecutionOptions
  constructor(
    process: string,
    argsOrOptions?: string[] | ProcessExecutionOptions,
    options?: ProcessExecutionOptions
  ) {
    if (typeof process !== "string") throw illegalArgument("process")
    this.process = process
    if (Array.isArray(argsOrOptions)) {
      this.args = argsOrOptions
      this.options = options
    } else {
      this.args = []
      this.options = argsOrOptions
    }
  }
}

export interface ShellQuotedString {
  value: string
  quoting: number
}

export interface ShellExecutionOptions {
  executable?: string
  shellArgs?: string[]
  shellQuoting?: unknown
  cwd?: string
  env?: Record<string, string>
}

export class ShellExecution {
  commandLine: string | undefined
  command: string | ShellQuotedString | undefined
  args: (string | ShellQuotedString)[]
  options?: ShellExecutionOptions
  constructor(
    commandOrLine: string | ShellQuotedString,
    argsOrOptions?: (string | ShellQuotedString)[] | ShellExecutionOptions,
    options?: ShellExecutionOptions
  ) {
    if (Array.isArray(argsOrOptions)) {
      if (!commandOrLine) throw illegalArgument("command can't be undefined or null")
      if (typeof commandOrLine !== "string" && typeof commandOrLine.value !== "string") {
        throw illegalArgument("command")
      }
      this.command = commandOrLine
      this.args = argsOrOptions
      this.options = options
    } else {
      if (typeof commandOrLine !== "string") throw illegalArgument("commandLine")
      this.commandLine = commandOrLine
      this.args = []
      this.options = argsOrOptions
    }
  }
}

export class CustomExecution {
  constructor(public readonly callback: (resolvedDefinition: unknown) => PromiseLike<unknown>) {}
}

export interface TaskDefinition {
  readonly type: string
  readonly [name: string]: unknown
}

type TaskExecution = ProcessExecution | ShellExecution | CustomExecution

export class Task {
  definition: TaskDefinition
  /** A workspace folder, `TaskScope.Global` / `Workspace`, or unset for the deprecated form. */
  scope: unknown
  detail?: string
  execution?: TaskExecution
  isBackground = false
  group?: TaskGroup
  presentationOptions: Record<string, unknown> = {}
  problemMatchers: string[]
  /** Whether the extension named problem matchers (VS Code then skips the type's defaults). */
  hasDefinedMatchers: boolean
  runOptions: { reevaluateOnRerun?: boolean } = {}
  private _name = ""
  private _source = ""

  constructor(
    definition: TaskDefinition,
    scopeOrName: unknown,
    nameOrSource: string,
    sourceOrExecution?: string | TaskExecution,
    executionOrMatchers?: TaskExecution | string | string[],
    problemMatchers?: string | string[]
  ) {
    this.definition = definition
    let matchers: string | string[] | undefined
    if (typeof scopeOrName === "string") {
      // `new Task(definition, name, source, execution?, problemMatchers?)`
      this.scope = undefined
      this.name = scopeOrName
      this.source = nameOrSource
      this.execution = sourceOrExecution as TaskExecution | undefined
      matchers = executionOrMatchers as string | string[] | undefined
    } else {
      this.scope = scopeOrName
      this.name = nameOrSource
      this.source = sourceOrExecution as string
      this.execution = executionOrMatchers as TaskExecution | undefined
      matchers = problemMatchers
    }
    this.problemMatchers =
      matchers === undefined ? [] : typeof matchers === "string" ? [matchers] : matchers
    this.hasDefinedMatchers = matchers !== undefined
  }

  get name(): string {
    return this._name
  }
  set name(value: string) {
    if (typeof value !== "string") throw illegalArgument("name")
    this._name = value
  }

  get source(): string {
    return this._source
  }
  set source(value: string) {
    if (typeof value !== "string" || value.length === 0) {
      throw illegalArgument("source must be a string of length > 0")
    }
    this._source = value
  }
}

// ── Drag and drop ───────────────────────────────────────────────────────

export class DataTransferItem {
  constructor(public readonly value: unknown) {}
  async asString(): Promise<string> {
    return typeof this.value === "string" ? this.value : JSON.stringify(this.value)
  }
  asFile(): undefined {
    return undefined
  }
}

export class DataTransfer implements Iterable<[mimeType: string, item: DataTransferItem]> {
  // Mime types are matched case-insensitively, as VS Code does.
  readonly #items = new Map<string, DataTransferItem>()
  get(mimeType: string): DataTransferItem | undefined {
    return this.#items.get(mimeType.toLowerCase())
  }
  set(mimeType: string, value: DataTransferItem): void {
    this.#items.set(mimeType.toLowerCase(), value)
  }
  forEach(
    callbackfn: (item: DataTransferItem, mimeType: string, dataTransfer: DataTransfer) => void,
    thisArg?: unknown
  ): void {
    for (const [mimeType, item] of this.#items) callbackfn.call(thisArg, item, mimeType, this)
  }
  *[Symbol.iterator](): IterableIterator<[mimeType: string, item: DataTransferItem]> {
    yield* this.#items
  }
}

// ── Notebooks ───────────────────────────────────────────────────────────

export const NotebookEditorRevealType = {
  Default: 0,
  InCenter: 1,
  InCenterIfOutsideViewport: 2,
  AtTop: 3,
} as const
export const NotebookControllerAffinity = { Default: 1, Preferred: 2 } as const
export const NotebookCellStatusBarAlignment = { Left: 1, Right: 2 } as const

export class NotebookRange {
  readonly start: number
  readonly end: number
  constructor(start: number, end: number) {
    if (!Number.isInteger(start) || start < 0)
      throw illegalArgument("start must be a positive integer")
    if (!Number.isInteger(end) || end < 0) throw illegalArgument("end must be a positive integer")
    this.start = Math.min(start, end)
    this.end = Math.max(start, end)
  }
  get isEmpty(): boolean {
    return this.start === this.end
  }
  with(change: { start?: number; end?: number }): NotebookRange {
    const start = change.start ?? this.start
    const end = change.end ?? this.end
    return start === this.start && end === this.end ? this : new NotebookRange(start, end)
  }
}

export class NotebookCellOutputItem {
  static text(value: string, mime = "text/plain"): NotebookCellOutputItem {
    return new NotebookCellOutputItem(new TextEncoder().encode(value), mime)
  }
  static json(value: unknown, mime = "text/x-json"): NotebookCellOutputItem {
    return NotebookCellOutputItem.text(JSON.stringify(value, undefined, "\t"), mime)
  }
  static stdout(value: string): NotebookCellOutputItem {
    return NotebookCellOutputItem.text(value, "application/vnd.code.notebook.stdout")
  }
  static stderr(value: string): NotebookCellOutputItem {
    return NotebookCellOutputItem.text(value, "application/vnd.code.notebook.stderr")
  }
  static error(value: Error): NotebookCellOutputItem {
    return NotebookCellOutputItem.json(
      { name: value.name, message: value.message, stack: value.stack },
      "application/vnd.code.notebook.error"
    )
  }
  constructor(
    public data: Uint8Array,
    public mime: string
  ) {}
}

export class NotebookCellOutput {
  constructor(
    public items: NotebookCellOutputItem[],
    public metadata?: Record<string, unknown>
  ) {}
}

export class NotebookCellData {
  outputs?: NotebookCellOutput[]
  metadata?: Record<string, unknown>
  executionSummary?: unknown
  constructor(
    public kind: (typeof NotebookCellKind)[keyof typeof NotebookCellKind],
    public value: string,
    public languageId: string
  ) {}
}

export class NotebookData {
  metadata?: Record<string, unknown>
  constructor(public cells: NotebookCellData[]) {}
}

export class NotebookEdit {
  static replaceCells(range: NotebookRange, newCells: NotebookCellData[]): NotebookEdit {
    return new NotebookEdit(range, newCells)
  }
  static insertCells(index: number, newCells: NotebookCellData[]): NotebookEdit {
    return new NotebookEdit(new NotebookRange(index, index), newCells)
  }
  static deleteCells(range: NotebookRange): NotebookEdit {
    return new NotebookEdit(range, [])
  }
  static updateCellMetadata(index: number, newCellMetadata: Record<string, unknown>): NotebookEdit {
    const edit = new NotebookEdit(new NotebookRange(index, index), [])
    edit.newCellMetadata = newCellMetadata
    return edit
  }
  static updateNotebookMetadata(newNotebookMetadata: Record<string, unknown>): NotebookEdit {
    const edit = new NotebookEdit(new NotebookRange(0, 0), [])
    edit.newNotebookMetadata = newNotebookMetadata
    return edit
  }

  newCellMetadata?: Record<string, unknown>
  newNotebookMetadata?: Record<string, unknown>
  constructor(
    public range: NotebookRange,
    public newCells: NotebookCellData[]
  ) {}
}

export class NotebookCellStatusBarItem {
  command?: string | Command
  tooltip?: string
  priority?: number
  accessibilityInformation?: { label: string; role?: string }
  constructor(
    public text: string,
    public alignment: (typeof NotebookCellStatusBarAlignment)[keyof typeof NotebookCellStatusBarAlignment]
  ) {}
}

// ── Debugging ───────────────────────────────────────────────────────────

export const DebugConsoleMode = { Separate: 0, MergeWithParent: 1 } as const
export const DebugConfigurationProviderTriggerKind = { Initial: 1, Dynamic: 2 } as const

export class DebugAdapterExecutable {
  readonly args: string[]
  constructor(
    public readonly command: string,
    args?: string[],
    public readonly options?: { env?: Record<string, string>; cwd?: string }
  ) {
    this.args = args ?? []
  }
}

export class DebugAdapterServer {
  constructor(
    public readonly port: number,
    public readonly host?: string
  ) {}
}

export class DebugAdapterNamedPipeServer {
  constructor(public readonly path: string) {}
}

export class DebugAdapterInlineImplementation {
  constructor(public readonly implementation: unknown) {}
}

export class Breakpoint {
  readonly enabled: boolean
  readonly condition?: string
  readonly hitCondition?: string
  readonly logMessage?: string
  #id: string | undefined
  constructor(enabled?: boolean, condition?: string, hitCondition?: string, logMessage?: string) {
    this.enabled = typeof enabled === "boolean" ? enabled : true
    if (typeof condition === "string") this.condition = condition
    if (typeof hitCondition === "string") this.hitCondition = hitCondition
    if (typeof logMessage === "string") this.logMessage = logMessage
  }
  get id(): string {
    this.#id ??= randomUUID()
    return this.#id
  }
}

export class SourceBreakpoint extends Breakpoint {
  constructor(
    public readonly location: Location,
    enabled?: boolean,
    condition?: string,
    hitCondition?: string,
    logMessage?: string
  ) {
    super(enabled, condition, hitCondition, logMessage)
    if (location === null) throw illegalArgument("location")
  }
}

export class FunctionBreakpoint extends Breakpoint {
  constructor(
    public readonly functionName: string,
    enabled?: boolean,
    condition?: string,
    hitCondition?: string,
    logMessage?: string
  ) {
    super(enabled, condition, hitCondition, logMessage)
  }
}

export class DebugThread {
  constructor(
    public readonly session: unknown,
    public readonly threadId: number
  ) {}
}

export class DebugStackFrame {
  constructor(
    public readonly session: unknown,
    public readonly threadId: number,
    public readonly frameId: number
  ) {}
}

// ── Comments ────────────────────────────────────────────────────────────

export const CommentThreadCollapsibleState = { Collapsed: 0, Expanded: 1 } as const
export const CommentMode = { Editing: 0, Preview: 1 } as const
export const CommentThreadState = { Unresolved: 0, Resolved: 1 } as const

// ── Testing and coverage ────────────────────────────────────────────────

export const TestRunProfileKind = { Run: 1, Debug: 2, Coverage: 3 } as const

export class TestTag {
  constructor(public readonly id: string) {}
}

export class TestRunRequest {
  constructor(
    public readonly include: readonly unknown[] | undefined = undefined,
    public readonly exclude: readonly unknown[] | undefined = undefined,
    public readonly profile: unknown = undefined,
    public readonly continuous = false,
    public readonly preserveFocus = true
  ) {}
}

export class TestMessage {
  static diff(message: string | MarkdownString, expected: string, actual: string): TestMessage {
    const testMessage = new TestMessage(message)
    testMessage.expectedOutput = expected
    testMessage.actualOutput = actual
    return testMessage
  }

  expectedOutput?: string
  actualOutput?: string
  location?: Location
  contextValue?: string
  constructor(public message: string | MarkdownString) {}
}

export class TestCoverageCount {
  constructor(
    public covered: number,
    public total: number
  ) {
    if (covered > total) {
      throw new Error(
        `The total number of covered items (${covered}) cannot be greater than the total (${total})`
      )
    }
  }
}

export class StatementCoverage {
  constructor(
    public executed: number | boolean,
    public location: Position | Range,
    public branches: BranchCoverage[] = []
  ) {}
}

export class BranchCoverage {
  constructor(
    public executed: number | boolean,
    public location?: Position | Range,
    public label?: string
  ) {}
}

export class DeclarationCoverage {
  constructor(
    public name: string,
    public executed: number | boolean,
    public location: Position | Range
  ) {}
}

export class FileCoverage {
  /** Counts statements, branches and declarations from the details; a kind with none is left out. */
  static fromDetails(
    uri: Uri,
    details: readonly (StatementCoverage | DeclarationCoverage)[]
  ): FileCoverage {
    const statements = new TestCoverageCount(0, 0)
    const branches = new TestCoverageCount(0, 0)
    const declarations = new TestCoverageCount(0, 0)
    for (const detail of details) {
      if (detail instanceof DeclarationCoverage) {
        declarations.total += 1
        if (detail.executed) declarations.covered += 1
        continue
      }
      statements.total += 1
      if (detail.executed) statements.covered += 1
      for (const branch of detail.branches) {
        branches.total += 1
        if (branch.executed) branches.covered += 1
      }
    }
    return new FileCoverage(
      uri,
      statements,
      branches.total > 0 ? branches : undefined,
      declarations.total > 0 ? declarations : undefined
    )
  }

  constructor(
    public readonly uri: Uri,
    public statementCoverage: TestCoverageCount,
    public branchCoverage?: TestCoverageCount,
    public declarationCoverage?: TestCoverageCount
  ) {}
}

// ── Tabs ────────────────────────────────────────────────────────────────

export class TabInputWebview {
  constructor(public readonly viewType: string) {}
}

export class TabInputNotebookDiff {
  constructor(
    public readonly original: Uri,
    public readonly modified: Uri,
    public readonly notebookType: string
  ) {}
}

export class TabInputTerminal {}

// ── Telemetry ───────────────────────────────────────────────────────────

/** A value the extension vouches is safe to log unredacted. */
export class TelemetryTrustedValue<T = unknown> {
  constructor(public readonly value: T) {}
}

// ── Chat history ────────────────────────────────────────────────────────

export const ChatResultFeedbackKind = { Unhelpful: 0, Helpful: 1 } as const

export class ChatResponseMarkdownPart {
  value: MarkdownString
  constructor(value: string | MarkdownString) {
    this.value = typeof value === "string" ? new MarkdownString(value) : value
  }
}

export class ChatResponseFileTreePart {
  constructor(
    public value: unknown[],
    public baseUri: Uri
  ) {}
}

export class ChatResponseAnchorPart {
  constructor(
    public value: Uri | Location,
    public title?: string
  ) {}
}

export class ChatResponseProgressPart {
  constructor(public value: string) {}
}

export class ChatResponseReferencePart {
  constructor(
    public value: Uri | Location,
    public iconPath?: unknown
  ) {}
}

export class ChatResponseCommandButtonPart {
  constructor(public value: Command) {}
}

type ChatResponsePart =
  | ChatResponseMarkdownPart
  | ChatResponseFileTreePart
  | ChatResponseAnchorPart
  | ChatResponseCommandButtonPart

export class ChatRequestTurn {
  constructor(
    public readonly prompt: string,
    public readonly command: string | undefined,
    public readonly references: unknown[],
    public readonly participant: string
  ) {}
}

export class ChatResponseTurn {
  constructor(
    public readonly response: ReadonlyArray<ChatResponsePart>,
    public readonly result: unknown,
    public readonly participant: string,
    public readonly command?: string
  ) {}
}
