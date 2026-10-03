/**
 * The always-on parts of `vscode.window`: status bar items and messages,
 * progress, and output channels.
 *
 * Each object keeps its state here and reports it whole, so the renderer
 * never has to merge partial updates:
 *
 *   - `window:statusBarItem {extensionId, itemId, state}` whenever a visible
 *     item changes (or is shown / hidden), `window:statusBarItemDispose`;
 *   - `window:setStatusBarMessage {extensionId, handle, text}`, cleared by
 *     `window:clearStatusBarMessage`;
 *   - `window:progressStart` (a request, answered once shown), then
 *     `window:progressReport` / `window:progressEnd`; the renderer cancels
 *     with `window:progressCancel {handle}`;
 *   - `window:outputChannel {extensionId, channel, op, …}` for every write.
 */

import type { RpcConnection } from "../rpc"
import { LogLevel, ProgressLocation } from "./api-types"
import { CancellationTokenSource, Disposable, EventEmitter, type CancellationToken } from "./types"

let nextId = 0
const uniqueId = (prefix: string) => {
  nextId += 1
  return `${prefix}:${nextId}`
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A request whose failure is the renderer's to report, never an unhandled rejection. */
function sendQuietly(connection: RpcConnection, method: string, params: unknown): void {
  connection.sendRequest(method, params).catch((error: unknown) => {
    process.stderr.write(`[vscode-shim] ${method} failed: ${describeError(error)}\n`)
  })
}

/** `string | MarkdownString` as the renderer shows it. */
function plainText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  if (typeof value === "object" && typeof (value as { value?: unknown }).value === "string") {
    return (value as { value: string }).value
  }
  return String(value)
}

/** A `ThemeColor` by id, or a CSS color string. */
function colorOf(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string"
  ) {
    return `theme:${(value as { id: string }).id}`
  }
  return undefined
}

function commandOf(value: unknown): { command: string; arguments?: unknown[] } | undefined {
  if (typeof value === "string") return { command: value }
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { command?: unknown }).command === "string"
  ) {
    const command = value as { command: string; arguments?: unknown[] }
    return {
      command: command.command,
      ...(command.arguments ? { arguments: command.arguments } : {}),
    }
  }
  return undefined
}

export class StatusBarItem {
  readonly itemId: string
  private visible = false
  private disposed = false
  private state: Record<string, unknown> = {}
  private flushQueued = false

  constructor(
    private readonly connection: RpcConnection,
    private readonly extensionId: string,
    readonly id: string,
    readonly alignment: number,
    readonly priority: number | undefined
  ) {
    this.itemId = uniqueId(`sb:${extensionId}`)
    for (const field of [
      "name",
      "text",
      "tooltip",
      "color",
      "backgroundColor",
      "command",
      "accessibilityInformation",
    ]) {
      Object.defineProperty(this, field, {
        get: () => this.state[field],
        set: (value: unknown) => {
          this.state[field] = value
          this.report()
        },
        enumerable: true,
      })
    }
    this.state.text = ""
  }

  declare name: string | undefined
  declare text: string
  declare tooltip: unknown
  declare color: unknown
  declare backgroundColor: unknown
  declare command: unknown
  declare accessibilityInformation: { label: string; role?: string } | undefined

  show(): void {
    if (this.disposed) return
    this.visible = true
    this.report()
  }

  hide(): void {
    if (this.disposed || !this.visible) return
    this.visible = false
    this.report()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    void this.connection.sendNotification("window:statusBarItemDispose", {
      extensionId: this.extensionId,
      itemId: this.itemId,
    })
  }

  private report(): void {
    if (this.disposed || this.flushQueued) return
    this.flushQueued = true
    queueMicrotask(() => {
      this.flushQueued = false
      if (this.disposed) return
      void this.connection.sendNotification("window:statusBarItem", {
        extensionId: this.extensionId,
        itemId: this.itemId,
        state: {
          id: this.id,
          alignment: this.alignment,
          ...(this.priority !== undefined ? { priority: this.priority } : {}),
          visible: this.visible,
          text: String(this.state.text ?? ""),
          ...(this.state.name ? { name: String(this.state.name) } : {}),
          ...(plainText(this.state.tooltip) ? { tooltip: plainText(this.state.tooltip) } : {}),
          ...(colorOf(this.state.color) ? { color: colorOf(this.state.color) } : {}),
          ...(colorOf(this.state.backgroundColor)
            ? { backgroundColor: colorOf(this.state.backgroundColor) }
            : {}),
          ...(commandOf(this.state.command) ? { command: commandOf(this.state.command) } : {}),
          ...(this.accessibilityInformation?.label
            ? { ariaLabel: this.accessibilityInformation.label }
            : {}),
        },
      })
    })
  }
}

/** `createStatusBarItem(alignment?, priority?)` or `createStatusBarItem(id, alignment?, priority?)`. */
export function createStatusBarItem(
  connection: RpcConnection,
  extensionId: string,
  args: unknown[]
): StatusBarItem {
  const [first, second, third] = args
  const withId = typeof first === "string"
  const id = withId ? first : `${extensionId}.entry.${nextId + 1}`
  const alignment = (withId ? second : first) as number | undefined
  const priority = (withId ? third : second) as number | undefined
  return new StatusBarItem(connection, extensionId, id, alignment ?? 1, priority)
}

/** `setStatusBarMessage(text, hideAfterTimeout?)` or `(text, hideWhenDone)`. */
export function setStatusBarMessage(
  connection: RpcConnection,
  extensionId: string,
  text: string,
  hideAfter?: number | Thenable<unknown>
): Disposable {
  const handle = uniqueId(`sbm:${extensionId}`)
  let cleared = false
  const clear = () => {
    if (cleared) return
    cleared = true
    void connection.sendNotification("window:clearStatusBarMessage", { extensionId, handle })
  }
  void connection.sendNotification("window:setStatusBarMessage", { extensionId, handle, text })
  if (typeof hideAfter === "number") {
    const timer = setTimeout(clear, hideAfter)
    return new Disposable(() => {
      clearTimeout(timer)
      clear()
    })
  }
  if (hideAfter && typeof (hideAfter as Thenable<unknown>).then === "function") {
    void Promise.resolve(hideAfter).finally(clear)
  }
  return new Disposable(clear)
}

const progressSourcesByConnection = new WeakMap<
  RpcConnection,
  Map<string, CancellationTokenSource>
>()

function progressSources(connection: RpcConnection): Map<string, CancellationTokenSource> {
  let sources = progressSourcesByConnection.get(connection)
  if (!sources) {
    sources = new Map()
    progressSourcesByConnection.set(connection, sources)
    const routed = sources
    connection.onRequest("window:progressCancel", (params) => {
      routed.get((params as { handle: string }).handle)?.cancel()
      return null
    })
  }
  return sources
}

/**
 * `window.withProgress`. The location decides where it shows: a notification
 * for `Notification`, the status bar otherwise (`Window`, `SourceControl`,
 * or a view id). The task's token is cancelled when the user cancels a
 * cancellable notification.
 */
export async function withProgress<R>(
  connection: RpcConnection,
  extensionId: string,
  options: { location: number | { viewId: string }; title?: string; cancellable?: boolean },
  task: (
    progress: { report(value: { message?: string; increment?: number }): void },
    token: CancellationToken
  ) => Thenable<R>
): Promise<R> {
  const handle = uniqueId(`progress:${extensionId}`)
  const source = new CancellationTokenSource()
  const sources = progressSources(connection)
  sources.set(handle, source)
  const location = options.location === ProgressLocation.Notification ? "notification" : "statusBar"
  sendQuietly(connection, "window:progressStart", {
    extensionId,
    handle,
    location,
    ...(options.title ? { title: options.title } : {}),
    cancellable: location === "notification" && Boolean(options.cancellable),
  })
  try {
    return await task(
      {
        report: (value) => {
          void connection.sendNotification("window:progressReport", {
            handle,
            ...(value.message !== undefined ? { message: value.message } : {}),
            ...(typeof value.increment === "number" ? { increment: value.increment } : {}),
          })
        },
      },
      source.token
    )
  } finally {
    sources.delete(handle)
    source.dispose()
    void connection.sendNotification("window:progressEnd", { handle })
  }
}

const LOG_LEVEL_NAMES: Record<number, "trace" | "debug" | "info" | "warn" | "error"> = {
  [LogLevel.Trace]: "trace",
  [LogLevel.Debug]: "debug",
  [LogLevel.Info]: "info",
  [LogLevel.Warning]: "warn",
  [LogLevel.Error]: "error",
}

function formatLogArgs(message: unknown, args: unknown[]): string {
  const parts = [message, ...args].map((part) => {
    if (part instanceof Error) return part.stack ?? part.message
    if (typeof part === "string") return part
    try {
      return JSON.stringify(part)
    } catch {
      return String(part)
    }
  })
  return parts.join(" ")
}

/**
 * `createOutputChannel(name, languageId?)`, or with `{ log: true }` a
 * `LogOutputChannel`. Its lines go to the plugin's log stream (Plugin
 * DevTools and the log panel), tagged with the channel name.
 */
export function createOutputChannel(
  connection: RpcConnection,
  extensionId: string,
  name: string,
  options?: string | { log: true },
  logLevel?: { value: number; onDidChange: EventEmitter<number>["event"] }
) {
  const isLog = typeof options === "object" && options !== null && options.log === true
  let disposed = false
  const send = (op: string, extra: Record<string, unknown> = {}) => {
    if (disposed) return
    void connection.sendNotification("window:outputChannel", {
      extensionId,
      channel: name,
      op,
      ...extra,
    })
  }
  const channel = {
    name,
    append: (value: string) => send("append", { value: String(value) }),
    appendLine: (value: string) => send("append", { value: `${String(value)}\n` }),
    replace: (value: string) => send("replace", { value: String(value) }),
    clear: () => send("clear"),
    show: (_columnOrPreserveFocus?: unknown, _preserveFocus?: boolean) => send("show"),
    hide: () => {
      // Nothing to hide: the channel is not displayed until the user opens the logs.
    },
    dispose: () => {
      send("dispose")
      disposed = true
    },
  }
  if (!isLog) return channel

  const level = logLevel ?? { value: LogLevel.Info, onDidChange: new EventEmitter<number>().event }
  const log =
    (messageLevel: number) =>
    (message: unknown, ...args: unknown[]) => {
      if (level.value === LogLevel.Off || messageLevel < level.value) return
      send("log", { level: LOG_LEVEL_NAMES[messageLevel], value: formatLogArgs(message, args) })
    }
  return {
    ...channel,
    get logLevel() {
      return level.value
    },
    onDidChangeLogLevel: level.onDidChange,
    trace: log(LogLevel.Trace),
    debug: log(LogLevel.Debug),
    info: log(LogLevel.Info),
    warn: log(LogLevel.Warning),
    error: (error: unknown, ...args: unknown[]) => log(LogLevel.Error)(error, ...args),
  }
}
