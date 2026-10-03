/**
 * `window.createTerminal` and the terminal events, over the app's terminal
 * dock.
 *
 * Each terminal an extension creates is a tab in the dock, labelled with its
 * name. A process terminal runs a shell (the user's default, or `shellPath`
 * with `shellArgs`) in a real PTY; the renderer spawns it behind the
 * extension's `terminal:spawn` permission and writes `sendText` into it
 * behind `terminal:write`. An extension terminal (`pty`) runs no process: the
 * dock shows what the extension's `Pseudoterminal` writes and hands it what
 * the user types and the tab's size.
 *
 * An extension sees the terminals it created: `window.terminals`,
 * `activeTerminal` (one of them when it is the dock's active tab) and the
 * open / close / active / state events. The user's own terminals and other
 * extensions' are not visible to it.
 *
 * Not supported, and documented on the types below: shell integration
 * (`Terminal.shellIntegration` stays `undefined` and its events never fire),
 * `strictEnv` and unsetting variables (an `env` value of `null`), and the
 * `message`, `location`, `iconPath` and `isTransient` options. `hideFromUser`
 * terminals still get a tab, but do not become the active one.
 */

import type { RpcConnection } from "../rpc"
import { Disposable, EventEmitter, Uri } from "./types"

export const TerminalExitReason = {
  Unknown: 0,
  Shutdown: 1,
  Process: 2,
  User: 3,
  Extension: 4,
} as const

export const TerminalLocation = { Panel: 1, Editor: 2 } as const

/** `TerminalShellExecutionCommandLineConfidence`, for extensions that read the enum. */
export const TerminalShellExecutionCommandLineConfidence = { Low: 0, Medium: 1, High: 2 } as const

export interface TerminalDimensions {
  readonly columns: number
  readonly rows: number
}

export interface TerminalExitStatus {
  readonly code: number | undefined
  readonly reason: number
}

export interface TerminalState {
  readonly isInteractedWith: boolean
  readonly shell: string | undefined
}

type Event<T> = (
  listener: (value: T) => unknown,
  thisArgs?: unknown,
  disposables?: unknown[]
) => Disposable

export interface Pseudoterminal {
  onDidWrite: Event<string>
  onDidOverrideDimensions?: Event<TerminalDimensions | undefined>
  onDidClose?: Event<void | number>
  onDidChangeName?: Event<string>
  open(initialDimensions: TerminalDimensions | undefined): void
  close(): void
  handleInput?(data: string): void
  setDimensions?(dimensions: TerminalDimensions): void
}

export interface TerminalOptions {
  name?: string
  shellPath?: string
  shellArgs?: string[] | string
  cwd?: string | Uri
  env?: Record<string, string | null | undefined>
  /** Not supported: the shell inherits the app's environment. */
  strictEnv?: boolean
  hideFromUser?: boolean
  /** Not supported: no banner is shown. */
  message?: string
  /** Not supported: terminals open in the dock. */
  location?: unknown
  /** Not supported: the tab keeps the dock's icon. */
  iconPath?: unknown
  color?: { id: string }
  /** Not supported: dock tabs are never restored after a restart anyway. */
  isTransient?: boolean
}

export interface ExtensionTerminalOptions {
  name: string
  pty: Pseudoterminal
  color?: { id: string }
  /** Not supported: the tab keeps the dock's icon. */
  iconPath?: unknown
  /** Not supported: terminals open in the dock. */
  location?: unknown
  /** Not supported: dock tabs are never restored after a restart anyway. */
  isTransient?: boolean
}

export interface Terminal {
  readonly name: string
  readonly processId: Thenable<number | undefined>
  readonly creationOptions: Readonly<TerminalOptions | ExtensionTerminalOptions>
  readonly exitStatus: TerminalExitStatus | undefined
  readonly state: TerminalState
  /**
   * Not supported: the dock's shell integration is not exposed to
   * extensions, so this is always `undefined` and
   * `onDidChangeTerminalShellIntegration` / `onDidStartTerminalShellExecution`
   * / `onDidEndTerminalShellExecution` never fire.
   */
  readonly shellIntegration: undefined
  sendText(text: string, shouldExecute?: boolean): void
  show(preserveFocus?: boolean): void
  hide(): void
  dispose(): void
}

type Thenable<T> = PromiseLike<T>

interface CreateResult {
  processId?: number
  /** The tab's name, for a terminal created without one. */
  name?: string
  /** An extension terminal's initial size. */
  dimensions?: TerminalDimensions
}

/** What `sendText` sends: VS Code's line endings, and Enter to run it. */
export function terminalInput(text: string, shouldExecute = true): string {
  const normalized = String(text).replace(/\r?\n/g, "\r")
  return shouldExecute && !normalized.endsWith("\r") ? `${normalized}\r` : normalized
}

function stderr(message: string): void {
  process.stderr.write(`[vscode-shim] ${message}\n`)
}

class ExtensionTerminal implements Terminal {
  private currentName: string
  private status: TerminalExitStatus | undefined
  private interacted = false
  /** Every renderer call waits for the create, in order. */
  private queue: Promise<unknown>
  readonly processId: Promise<number | undefined>
  /** Resolves once the renderer has made the terminal; rejects with why it could not. */
  readonly ready: Promise<void>
  readonly creationOptions: Readonly<TerminalOptions | ExtensionTerminalOptions>
  readonly shellIntegration = undefined
  private readonly subscriptions: Disposable[] = []
  private closed = false

  constructor(
    private readonly registry: TerminalRegistry,
    private readonly connection: RpcConnection,
    readonly extensionId: string,
    readonly terminalId: string,
    options: TerminalOptions | ExtensionTerminalOptions
  ) {
    this.creationOptions = Object.freeze({ ...options })
    // An unnamed process terminal takes the name the dock gives its tab.
    this.currentName = options.name ?? ""
    const created = connection.sendRequest<CreateResult | null>("terminal:create", {
      extensionId,
      terminalId,
      ...wireOptions(options),
    })
    this.queue = created.catch(() => undefined)
    this.ready = created.then(() => undefined)
    // Callers that never ask are not left with an unhandled rejection.
    this.ready.catch(() => undefined)
    this.processId = created.then(
      (result) => (typeof result?.processId === "number" ? result.processId : undefined),
      () => undefined
    )
    created.then(
      (result) => {
        if (!options.name && typeof result?.name === "string") this.currentName = result.name
        if (isExtensionOptions(options)) this.openPty(options.pty, result?.dimensions)
      },
      (error: unknown) => {
        stderr(
          `${extensionId}: terminal "${this.currentName}" was not created: ${error instanceof Error ? error.message : String(error)}`
        )
        this.close(undefined, TerminalExitReason.Unknown)
      }
    )
  }

  get name(): string {
    return this.currentName
  }

  get exitStatus(): TerminalExitStatus | undefined {
    return this.status
  }

  get state(): TerminalState {
    return { isInteractedWith: this.interacted, shell: undefined }
  }

  get pty(): Pseudoterminal | undefined {
    const options = this.creationOptions
    return isExtensionOptions(options) ? options.pty : undefined
  }

  /** Send to the renderer once the terminal exists there, in call order. */
  private send(method: string, params: Record<string, unknown>): void {
    if (this.closed) return
    this.queue = this.queue.then(() =>
      this.connection
        .sendRequest(method, {
          extensionId: this.extensionId,
          terminalId: this.terminalId,
          ...params,
        })
        .catch((error: unknown) => {
          stderr(
            `${this.extensionId}: ${method} on terminal "${this.currentName}" failed: ${error instanceof Error ? error.message : String(error)}`
          )
        })
    )
  }

  private openPty(pty: Pseudoterminal, dimensions: TerminalDimensions | undefined): void {
    const listen = <T>(event: Event<T> | undefined, listener: (value: T) => void) => {
      if (typeof event === "function") this.subscriptions.push(event(listener))
    }
    listen(pty.onDidWrite, (data) => this.send("terminal:ptyWrite", { data: String(data) }))
    listen(pty.onDidClose, (code) => {
      const exitCode = typeof code === "number" ? code : undefined
      this.send("terminal:ptyClose", { code: exitCode ?? null })
    })
    listen(pty.onDidChangeName, (name) => {
      this.currentName = String(name)
      this.send("terminal:rename", { name: this.currentName })
    })
    try {
      pty.open(dimensions)
    } catch (error) {
      stderr(
        `${this.extensionId}: Pseudoterminal.open threw: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  sendText(text: string, shouldExecute = true): void {
    const data = terminalInput(text, shouldExecute)
    const pty = this.pty
    if (pty) {
      // As in VS Code, text sent to an extension terminal is its input.
      this.queue = this.queue.then(() => pty.handleInput?.(data))
      return
    }
    this.send("terminal:sendText", { data })
  }

  show(preserveFocus?: boolean): void {
    this.send("terminal:show", { preserveFocus: preserveFocus === true })
  }

  hide(): void {
    this.send("terminal:hide", {})
  }

  dispose(): void {
    if (this.closed) return
    this.send("terminal:dispose", {})
  }

  /** The renderer reported input from the user. */
  markInteracted(): void {
    if (this.interacted) return
    this.interacted = true
    this.registry.onDidChangeState.fire(this)
  }

  input(data: string): void {
    this.markInteracted()
    try {
      this.pty?.handleInput?.(data)
    } catch (error) {
      stderr(
        `${this.extensionId}: Pseudoterminal.handleInput threw: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  resize(dimensions: TerminalDimensions): void {
    try {
      this.pty?.setDimensions?.(dimensions)
    } catch (error) {
      stderr(
        `${this.extensionId}: Pseudoterminal.setDimensions threw: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  rename(name: string): void {
    this.currentName = name
  }

  /** The terminal ended, for whatever reason; tell the extension once. */
  close(code: number | undefined, reason: number): void {
    if (this.closed) return
    this.closed = true
    this.status = Object.freeze({ code, reason })
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose()
    const pty = this.pty
    if (pty && reason !== TerminalExitReason.Process) {
      try {
        pty.close()
      } catch (error) {
        stderr(
          `${this.extensionId}: Pseudoterminal.close threw: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    this.registry.closed(this)
  }
}

function isExtensionOptions(
  options: TerminalOptions | ExtensionTerminalOptions
): options is ExtensionTerminalOptions {
  return (
    typeof (options as ExtensionTerminalOptions).pty === "object" &&
    (options as ExtensionTerminalOptions).pty !== null
  )
}

/** The options as the renderer reads them. */
function wireOptions(options: TerminalOptions | ExtensionTerminalOptions): Record<string, unknown> {
  const color = options.color && typeof options.color.id === "string" ? options.color.id : undefined
  if (isExtensionOptions(options)) {
    return { kind: "pty", name: options.name, ...(color ? { color } : {}) }
  }
  const cwd =
    options.cwd instanceof Uri
      ? options.cwd.fsPath
      : typeof options.cwd === "string"
        ? options.cwd
        : undefined
  const env: Record<string, string> = {}
  const unset: string[] = []
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (typeof value === "string") env[key] = value
    else if (value === null) unset.push(key)
  }
  return {
    kind: "process",
    ...(options.name ? { name: options.name } : {}),
    ...(options.shellPath ? { shellPath: options.shellPath } : {}),
    ...(options.shellArgs !== undefined
      ? {
          shellArgs: Array.isArray(options.shellArgs)
            ? options.shellArgs.map(String)
            : [String(options.shellArgs)],
        }
      : {}),
    ...(cwd ? { cwd } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(unset.length > 0 ? { unsetEnv: unset } : {}),
    ...(options.strictEnv ? { strictEnv: true } : {}),
    ...(options.hideFromUser ? { hideFromUser: true } : {}),
    ...(color ? { color } : {}),
  }
}

/**
 * The host's terminals, by id. The renderer's reports (`terminal:*` requests
 * below) find a terminal here; each extension's `window` filters by owner.
 */
export class TerminalRegistry {
  private readonly terminals = new Map<string, ExtensionTerminal>()
  private activeId: string | null = null
  readonly onDidOpen = new EventEmitter<Terminal>()
  readonly onDidClose = new EventEmitter<Terminal>()
  readonly onDidChangeActive = new EventEmitter<string | null>()
  readonly onDidChangeState = new EventEmitter<Terminal>()
  private sequence = 0

  attach(connection: RpcConnection): void {
    const find = (params: unknown) => {
      const id = (params as { terminalId?: unknown }).terminalId
      return typeof id === "string" ? this.terminals.get(id) : undefined
    }
    connection.onRequest("terminal:closed", (params) => {
      const { code, reason } = params as { code?: unknown; reason?: unknown }
      find(params)?.close(
        typeof code === "number" ? code : undefined,
        typeof reason === "number" ? reason : TerminalExitReason.Unknown
      )
      return null
    })
    connection.onRequest("terminal:ptyInput", (params) => {
      find(params)?.input(String((params as { data?: unknown }).data ?? ""))
      return null
    })
    connection.onRequest("terminal:ptyResize", (params) => {
      const { columns, rows } = params as { columns?: unknown; rows?: unknown }
      if (typeof columns === "number" && typeof rows === "number") {
        find(params)?.resize({ columns, rows })
      }
      return null
    })
    connection.onRequest("terminal:interacted", (params) => {
      find(params)?.markInteracted()
      return null
    })
    connection.onRequest("terminal:renamed", (params) => {
      const { name } = params as { name?: unknown }
      if (typeof name === "string") find(params)?.rename(name)
      return null
    })
    connection.onRequest("terminal:activeChanged", (params) => {
      const id = (params as { terminalId?: unknown }).terminalId
      const next = typeof id === "string" && this.terminals.has(id) ? id : null
      if (next !== this.activeId) {
        this.activeId = next
        this.onDidChangeActive.fire(next)
      }
      return null
    })
  }

  create(
    connection: RpcConnection,
    extensionId: string,
    options: TerminalOptions | ExtensionTerminalOptions
  ): Terminal {
    this.sequence += 1
    const terminalId = `term:${extensionId}:${this.sequence}`
    const terminal = new ExtensionTerminal(this, connection, extensionId, terminalId, options)
    this.terminals.set(terminalId, terminal)
    this.onDidOpen.fire(terminal)
    return terminal
  }

  /** Called by a terminal as it ends. */
  closed(terminal: ExtensionTerminal): void {
    this.terminals.delete(terminal.terminalId)
    if (this.activeId === terminal.terminalId) {
      this.activeId = null
      this.onDidChangeActive.fire(null)
    }
    this.onDidClose.fire(terminal)
  }

  /** Resolves once the renderer has made `terminal`; rejects with why it could not. */
  whenCreated(terminal: Terminal): Promise<void> {
    return terminal instanceof ExtensionTerminal
      ? terminal.ready
      : Promise.reject(new Error("The terminal was not created by this host"))
  }

  ownerOf(terminal: Terminal): string | undefined {
    return terminal instanceof ExtensionTerminal ? terminal.extensionId : undefined
  }

  of(extensionId: string): Terminal[] {
    return [...this.terminals.values()].filter((terminal) => terminal.extensionId === extensionId)
  }

  active(extensionId: string): Terminal | undefined {
    const terminal = this.activeId ? this.terminals.get(this.activeId) : undefined
    return terminal?.extensionId === extensionId ? terminal : undefined
  }

  /** The extension stopped: its extension terminals end with it. */
  closeAll(extensionId: string): void {
    for (const terminal of this.of(extensionId) as ExtensionTerminal[]) {
      if (terminal.pty) terminal.close(undefined, TerminalExitReason.Shutdown)
    }
  }
}

/** `createTerminal(name?, shellPath?, shellArgs?)` or `createTerminal(options)`. */
export function terminalOptionsOf(args: unknown[]): TerminalOptions | ExtensionTerminalOptions {
  const [first, shellPath, shellArgs] = args
  if (first && typeof first === "object") return first as TerminalOptions | ExtensionTerminalOptions
  return {
    ...(typeof first === "string" ? { name: first } : {}),
    ...(typeof shellPath === "string" ? { shellPath } : {}),
    ...(shellArgs !== undefined ? { shellArgs: shellArgs as string[] | string } : {}),
  }
}

/** `onDidChangeActiveTerminal` for one extension: fires when its view of the active terminal changes. */
function activeChanges(registry: TerminalRegistry, extensionId: string) {
  return (
    listener: (terminal: Terminal | undefined) => unknown,
    thisArgs?: unknown,
    disposables?: unknown[]
  ): Disposable => {
    let last = registry.active(extensionId)
    const subscription = registry.onDidChangeActive.event(() => {
      const next = registry.active(extensionId)
      if (next === last) return
      last = next
      listener.call(thisArgs, next)
    })
    if (Array.isArray(disposables)) disposables.push(subscription)
    return subscription
  }
}

/** The `window` members about terminals, for one extension. */
export function createTerminalWindowMembers(input: {
  registry: TerminalRegistry
  connection: RpcConnection
  extensionId: string
}) {
  const { registry, connection, extensionId } = input
  const own = (terminal: Terminal) => registry.ownerOf(terminal) === extensionId
  const ownEvents =
    (source: EventEmitter<Terminal>) =>
    (
      listener: (terminal: Terminal) => unknown,
      thisArgs?: unknown,
      disposables?: unknown[]
    ): Disposable => {
      const subscription = source.event((terminal) => {
        if (own(terminal)) listener.call(thisArgs, terminal)
      })
      if (Array.isArray(disposables)) disposables.push(subscription)
      return subscription
    }
  const never = new EventEmitter<never>()
  return {
    createTerminal(...args: unknown[]): Terminal {
      return registry.create(connection, extensionId, terminalOptionsOf(args))
    },
    get terminals(): readonly Terminal[] {
      return Object.freeze(registry.of(extensionId))
    },
    get activeTerminal(): Terminal | undefined {
      return registry.active(extensionId)
    },
    onDidOpenTerminal: ownEvents(registry.onDidOpen),
    onDidCloseTerminal: ownEvents(registry.onDidClose),
    onDidChangeTerminalState: ownEvents(registry.onDidChangeState),
    onDidChangeActiveTerminal: activeChanges(registry, extensionId),
    /** Not supported: see `Terminal.shellIntegration`. */
    onDidChangeTerminalShellIntegration: never.event,
    /** Not supported: see `Terminal.shellIntegration`. */
    onDidStartTerminalShellExecution: never.event,
    /** Not supported: see `Terminal.shellIntegration`. */
    onDidEndTerminalShellExecution: never.event,
  }
}
