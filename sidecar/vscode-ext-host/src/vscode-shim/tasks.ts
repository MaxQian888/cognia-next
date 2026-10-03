/**
 * `vscode.tasks`: task providers, fetching tasks, and running them in the
 * app's terminal dock.
 *
 * Providers register in the renderer's task registry
 * (`lib/plugin/commands/tasks-registry.ts`), so `fetchTasks` in any
 * extension sees every extension's tasks. They cross as {@link WireTask}s and
 * come back as `Task`s.
 *
 * `executeTask` runs a task in a dock terminal this host creates for the
 * extension, the same way `window.createTerminal` does (a process terminal
 * needs the extension's `terminal:spawn` permission):
 *
 *   - `ShellExecution`: the shell (`options.executable`, else the user's)
 *     runs the command line (`-c`, `/d /c` for cmd, `-Command` for
 *     PowerShell); `command` and `args` are quoted for that shell as their
 *     `ShellQuoting` says, plain strings strongly when they need it.
 *   - `ProcessExecution`: the process runs with its arguments, no shell.
 *   - `CustomExecution`: the extension's `Pseudoterminal`, in an extension
 *     terminal. Only the extension that provides a custom task can run it.
 *
 * A task without an execution is first resolved by this extension's own
 * provider for its type. `${workspaceFolder}`, `${workspaceFolderBasename}`,
 * `${userHome}`, `${pathSeparator}` and `${env:NAME}` are substituted in the
 * command, arguments and working directory; other variables are left as
 * written. A task runs in its workspace folder (or the first one) unless its
 * options name a directory.
 *
 * Each run is a `TaskExecution` in `taskExecutions` until its terminal
 * closes. `onDidStartTask` fires when the terminal opens and
 * `onDidStartTaskProcess` when its process starts (shell and process
 * executions); `onDidEndTaskProcess` carries the exit code and
 * `onDidEndTask` follows. `terminate()` closes the terminal.
 * `presentationOptions.reveal`: `Always` (the default) shows the terminal,
 * `focus` decides whether it takes focus; `Silent` and `Never` leave the dock
 * as it is.
 *
 * Not supported, and stated in the plugin docs: problem matchers (no
 * diagnostics are made from a task's output), `dependsOn` and
 * `runOptions`. The dock does not report process ids, so
 * `TaskProcessStartEvent.processId` is `undefined`. An extension sees only
 * the executions it started, since every extension has its own host.
 */

import * as os from "node:os"
import * as nodePath from "node:path"

import { TaskRevealKind, TaskScope } from "./api-types"
import { defaultShell } from "./env"
import type { Terminal } from "./terminal"
import {
  CancellationTokenSource,
  Disposable,
  EventEmitter,
  Uri,
  type CancellationToken,
} from "./types"
import {
  CustomExecution,
  ProcessExecution,
  ShellExecution,
  ShellQuoting,
  Task,
  TaskGroup,
  type ShellQuotedString,
  type TaskDefinition,
} from "./value-types"
import type { ShimDependencies } from "./index"
import type { WorkspaceFolder } from "./workspace-folders"

/** A task as it crosses to the renderer and back. */
export interface WireTask {
  /** `${extension id}/${source}/${name}`: who provided it, and which. */
  id: string
  /** The extension that provided it. */
  extensionId: string
  name: string
  source: string
  definition: TaskDefinition
  detail?: string
  /** `TaskGroup.id`. */
  group?: string
  isBackground: boolean
  problemMatchers: string[]
  /** `global`, `workspace`, a workspace folder's URI, or absent for the deprecated form. */
  scope?: "global" | "workspace" | { folder: string }
  execution?:
    | {
        kind: "shell"
        commandLine?: string
        command?: WireShellArg
        args: WireShellArg[]
        options?: Record<string, unknown>
      }
    | { kind: "process"; process: string; args: string[]; options?: Record<string, unknown> }
    | { kind: "custom" }
  presentationOptions?: Record<string, unknown>
}

type WireShellArg = string | { value: string; quoting: number }

type TaskExecutionKind = ProcessExecution | ShellExecution | CustomExecution

export interface TaskExecution {
  readonly task: Task
  terminate(): void
}

interface TaskProvider {
  provideTasks(
    token: CancellationToken
  ): Task[] | null | undefined | Thenable<Task[] | null | undefined>
  resolveTask?(
    task: Task,
    token: CancellationToken
  ): Task | null | undefined | Thenable<Task | null | undefined>
}

const PROBLEM_MATCHERS_NOTE =
  "problem matchers are not supported in Cognia, so no diagnostics are made from the task's output"

function warn(extensionId: string, message: string): void {
  process.stderr.write(`[vscode-shim] WARN ${extensionId}: ${message}\n`)
}

// ── Converting tasks ────────────────────────────────────────────────────

function wireOptions(options: object | undefined): Record<string, unknown> | undefined {
  if (!options) return undefined
  const { cwd, env, executable, shellArgs, shellQuoting } = options as Record<string, unknown>
  const out: Record<string, unknown> = {}
  if (typeof cwd === "string") out.cwd = cwd
  if (env && typeof env === "object") out.env = env
  if (typeof executable === "string") out.executable = executable
  if (Array.isArray(shellArgs)) out.shellArgs = shellArgs.map(String)
  if (shellQuoting && typeof shellQuoting === "object") out.shellQuoting = shellQuoting
  return Object.keys(out).length > 0 ? out : undefined
}

function wireExecution(execution: unknown): WireTask["execution"] {
  if (execution instanceof ShellExecution) {
    return {
      kind: "shell",
      ...(execution.commandLine !== undefined ? { commandLine: execution.commandLine } : {}),
      ...(execution.command !== undefined ? { command: execution.command } : {}),
      args: execution.args,
      ...(wireOptions(execution.options) ? { options: wireOptions(execution.options) } : {}),
    }
  }
  if (execution instanceof ProcessExecution) {
    return {
      kind: "process",
      process: execution.process,
      args: execution.args,
      ...(wireOptions(execution.options) ? { options: wireOptions(execution.options) } : {}),
    }
  }
  if (execution instanceof CustomExecution) return { kind: "custom" }
  return undefined
}

function wireScope(scope: unknown): WireTask["scope"] {
  if (scope === TaskScope.Global) return "global"
  if (scope === TaskScope.Workspace) return "workspace"
  const uri = (scope as { uri?: unknown } | null)?.uri
  return uri instanceof Uri ? { folder: uri.toString() } : undefined
}

export function toWireTask(task: Task, extensionId: string): WireTask {
  const execution = wireExecution(task.execution)
  return {
    id: `${extensionId}/${task.source}/${task.name}`,
    extensionId,
    name: task.name,
    source: task.source,
    definition: { ...task.definition },
    ...(task.detail !== undefined ? { detail: task.detail } : {}),
    ...(task.group ? { group: task.group.id } : {}),
    isBackground: task.isBackground,
    problemMatchers: [...task.problemMatchers],
    ...(wireScope(task.scope) ? { scope: wireScope(task.scope) } : {}),
    ...(execution ? { execution } : {}),
    ...(Object.keys(task.presentationOptions).length > 0
      ? { presentationOptions: { ...task.presentationOptions } }
      : {}),
  }
}

const GROUPS: Record<string, TaskGroup> = {
  clean: TaskGroup.Clean,
  build: TaskGroup.Build,
  rebuild: TaskGroup.Rebuild,
  test: TaskGroup.Test,
}

/**
 * A wire task as a `Task`. A custom task from another extension cannot run
 * here: its execution refuses with that reason.
 */
export function fromWireTask(wire: WireTask, folders: readonly WorkspaceFolder[]): Task {
  let execution: TaskExecutionKind | undefined
  const wireExec = wire.execution
  if (wireExec?.kind === "shell") {
    execution =
      wireExec.command !== undefined
        ? new ShellExecution(wireExec.command, wireExec.args, wireExec.options)
        : new ShellExecution(wireExec.commandLine ?? "", wireExec.options)
  } else if (wireExec?.kind === "process") {
    execution = new ProcessExecution(wireExec.process, wireExec.args, wireExec.options)
  } else if (wireExec?.kind === "custom") {
    execution = new CustomExecution(async () => {
      throw new Error(
        `Task "${wire.name}" is a custom task of ${wire.extensionId}; only that extension can run it`
      )
    })
  }
  const scope =
    wire.scope === "global"
      ? TaskScope.Global
      : wire.scope === "workspace"
        ? TaskScope.Workspace
        : wire.scope
          ? (folders.find(
              (folder) => folder.uri.toString() === (wire.scope as { folder: string }).folder
            ) ?? TaskScope.Workspace)
          : undefined
  const task =
    scope === undefined
      ? new Task(
          wire.definition,
          wire.name,
          wire.source,
          execution as ProcessExecution | ShellExecution | undefined,
          wire.problemMatchers
        )
      : new Task(wire.definition, scope, wire.name, wire.source, execution, wire.problemMatchers)
  if (wire.detail !== undefined) task.detail = wire.detail
  if (wire.group && GROUPS[wire.group]) task.group = GROUPS[wire.group]
  task.isBackground = wire.isBackground === true
  if (wire.presentationOptions) task.presentationOptions = { ...wire.presentationOptions }
  return task
}

// ── Building the terminal ───────────────────────────────────────────────

type ShellFamily = "posix" | "cmd" | "powershell"

function shellFamily(shell: string): ShellFamily {
  // Either separator: a Windows shell path is named the same on any host.
  const name = (shell.split(/[\\/]/).pop() ?? shell).toLowerCase()
  if (name === "cmd" || name === "cmd.exe") return "cmd"
  if (name.startsWith("powershell") || name.startsWith("pwsh")) return "powershell"
  return "posix"
}

/** The arguments that make `shell` run one command line. */
export function shellCommandArgs(shell: string): string[] {
  const family = shellFamily(shell)
  if (family === "cmd") return ["/d", "/c"]
  if (family === "powershell") return ["-Command"]
  return ["-c"]
}

const NEEDS_QUOTING = /[\s"'`$&|;<>()*?[\]{}!#~\\^%]/

/** One argument as `shell` reads it, quoted as `quoting` says. */
export function quoteShellArg(arg: WireShellArg, shell: string): string {
  const value = typeof arg === "string" ? arg : arg.value
  const quoting =
    typeof arg === "string"
      ? NEEDS_QUOTING.test(value) || value === ""
        ? ShellQuoting.Strong
        : null
      : arg.quoting
  if (quoting === null) return value
  const family = shellFamily(shell)
  if (family === "cmd") {
    if (quoting === ShellQuoting.Escape) return value.replace(/([&|<>()^"%!])/g, "^$1")
    return `"${value.replace(/"/g, '""')}"`
  }
  if (family === "powershell") {
    if (quoting === ShellQuoting.Escape) return value.replace(/([\s`"'$&|;<>(){}@#,])/g, "`$1")
    if (quoting === ShellQuoting.Weak) return `"${value.replace(/(["`$])/g, "`$1")}"`
    return `'${value.replace(/'/g, "''")}'`
  }
  if (quoting === ShellQuoting.Escape) return value.replace(/([^A-Za-z0-9_\-.,:/@%+=])/g, "\\$1")
  if (quoting === ShellQuoting.Weak) return `"${value.replace(/(["\\$`])/g, "\\$1")}"`
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Substitute the variables a task may use; others stay as written. */
export function substituteTaskVariables(
  text: string,
  folder: WorkspaceFolder | undefined,
  env: NodeJS.ProcessEnv = process.env
): string {
  return text.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
    if (name === "workspaceFolder" || name === "workspaceRoot") return folder?.uri.fsPath ?? match
    if (name === "workspaceFolderBasename") return folder?.name ?? match
    if (name === "userHome") return os.homedir()
    if (name === "pathSeparator") return nodePath.sep
    if (name.startsWith("env:")) return env[name.slice(4)] ?? ""
    return match
  })
}

/** The process terminal a shell or process execution runs in. */
export function taskTerminalOptions(
  task: Task,
  folder: WorkspaceFolder | undefined,
  shell: string = defaultShell()
): {
  name: string
  shellPath: string
  shellArgs: string[]
  cwd?: string
  env?: Record<string, string>
  hideFromUser?: boolean
} {
  const execution = task.execution
  const sub = (text: string) => substituteTaskVariables(text, folder)
  const options = (execution as ShellExecution | ProcessExecution).options ?? {}
  const cwd = typeof options.cwd === "string" ? sub(options.cwd) : folder?.uri.fsPath
  const env =
    options.env && typeof options.env === "object"
      ? Object.fromEntries(
          Object.entries(options.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        )
      : undefined
  let shellPath: string
  let shellArgs: string[]
  if (execution instanceof ProcessExecution) {
    shellPath = sub(execution.process)
    shellArgs = execution.args.map(sub)
  } else if (execution instanceof ShellExecution) {
    const shellOptions = execution.options ?? {}
    shellPath = typeof shellOptions.executable === "string" ? shellOptions.executable : shell
    const commandLine =
      execution.commandLine !== undefined
        ? sub(execution.commandLine)
        : [execution.command!, ...execution.args]
            .map((arg) => (typeof arg === "string" ? sub(arg) : { ...arg, value: sub(arg.value) }))
            .map((arg) => quoteShellArg(arg as WireShellArg, shellPath))
            .join(" ")
    shellArgs = [
      ...(Array.isArray(shellOptions.shellArgs)
        ? shellOptions.shellArgs.map(String)
        : shellCommandArgs(shellPath)),
      commandLine,
    ]
  } else {
    throw new Error(`Task "${task.name}" has no shell or process execution`)
  }
  const reveal = task.presentationOptions.reveal
  return {
    name: `${task.source}: ${task.name}`,
    shellPath,
    shellArgs,
    ...(cwd ? { cwd } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    ...(reveal === TaskRevealKind.Silent || reveal === TaskRevealKind.Never
      ? { hideFromUser: true }
      : {}),
  }
}

// ── The namespace ───────────────────────────────────────────────────────

export function createTasksNamespace(deps: ShimDependencies) {
  const { connection, extensionId, registerProviderCallback } = deps
  const providers = new Map<string, TaskProvider>()
  /** The tasks this extension last provided, by wire id: fetched back, they are the same objects. */
  const provided = new Map<string, Task>()
  const executions = new Set<TaskExecution>()
  const onDidStartTask = new EventEmitter<{ execution: TaskExecution }>()
  const onDidEndTask = new EventEmitter<{ execution: TaskExecution }>()
  const onDidStartTaskProcess = new EventEmitter<{
    execution: TaskExecution
    processId: number | undefined
  }>()
  const onDidEndTaskProcess = new EventEmitter<{
    execution: TaskExecution
    exitCode: number | undefined
  }>()
  let warnedMatchers = false

  const folderOf = (task: Task): WorkspaceFolder | undefined => {
    const folders = deps.folders.folders ?? []
    const scope = task.scope as { uri?: unknown } | undefined
    if (scope && scope.uri instanceof Uri) {
      return (
        folders.find((folder) => folder.uri.toString() === (scope.uri as Uri).toString()) ??
        (scope as WorkspaceFolder)
      )
    }
    return folders[0]
  }

  async function resolve(task: Task): Promise<Task> {
    if (task.execution) return task
    const provider = providers.get(task.definition?.type)
    if (!provider?.resolveTask) {
      throw new Error(
        `Task "${task.name}" has no execution, and this extension provides no way to resolve "${task.definition?.type}" tasks`
      )
    }
    const source = new CancellationTokenSource()
    let resolved: Task | null | undefined
    try {
      resolved = await provider.resolveTask(task, source.token)
    } finally {
      source.dispose()
    }
    if (!resolved?.execution)
      throw new Error(`Task "${task.name}" did not resolve to anything to run`)
    return resolved
  }

  async function executeTask(input: Task): Promise<TaskExecution> {
    if (!(input instanceof Task)) throw new TypeError("executeTask needs a vscode.Task")
    const task = await resolve(input)
    if (task.problemMatchers.length > 0 && !warnedMatchers) {
      warnedMatchers = true
      warn(extensionId, `task "${task.name}": ${PROBLEM_MATCHERS_NOTE}`)
    }
    const folder = folderOf(task)
    let terminal: Terminal
    const isProcess = !(task.execution instanceof CustomExecution)
    if (task.execution instanceof CustomExecution) {
      const pty = await task.execution.callback(task.definition)
      terminal = deps.terminals.create(connection, extensionId, {
        name: `${task.source}: ${task.name}`,
        pty: pty as never,
      })
    } else {
      terminal = deps.terminals.create(connection, extensionId, taskTerminalOptions(task, folder))
    }
    await deps.terminals.whenCreated(terminal)

    const execution: TaskExecution = {
      task,
      terminate: () => terminal.dispose(),
    }
    executions.add(execution)
    const closed = deps.terminals.onDidClose.event((closedTerminal) => {
      if (closedTerminal !== terminal) return
      closed.dispose()
      if (isProcess) {
        onDidEndTaskProcess.fire({ execution, exitCode: terminal.exitStatus?.code })
      }
      executions.delete(execution)
      onDidEndTask.fire({ execution })
    })
    onDidStartTask.fire({ execution })
    if (isProcess) {
      void terminal.processId.then((processId) => {
        if (executions.has(execution)) onDidStartTaskProcess.fire({ execution, processId })
      })
    }
    const reveal = task.presentationOptions.reveal
    if (reveal === undefined || reveal === TaskRevealKind.Always) {
      terminal.show(task.presentationOptions.focus !== true)
    }
    return execution
  }

  return {
    registerTaskProvider(type: string, provider: TaskProvider): Disposable {
      if (typeof type !== "string" || !type) throw new TypeError("A task provider needs a type")
      providers.set(type, provider)
      const token = `tasks:${extensionId}:${type}:provideTasks`
      const unregister = registerProviderCallback(token, async (_payload, call) => {
        const tasks = await provider.provideTasks(call.cancellation)
        return (Array.isArray(tasks) ? tasks : [])
          .filter((task): task is Task => task instanceof Task)
          .map((task) => {
            const wire = toWireTask(task, extensionId)
            provided.set(wire.id, task)
            return wire
          })
      })
      void connection
        .sendRequest("tasks:registerProvider", {
          extensionId,
          type,
          tokens: { provideTasks: token },
        })
        .catch((error: unknown) =>
          warn(
            extensionId,
            `task provider "${type}" was not registered: ${error instanceof Error ? error.message : String(error)}`
          )
        )
      return new Disposable(() => {
        if (providers.get(type) === provider) providers.delete(type)
        unregister()
        void connection.sendNotification("tasks:unregisterProvider", { extensionId, type })
      })
    },
    async fetchTasks(filter?: { type?: string }): Promise<Task[]> {
      const wire = await connection.sendRequest<WireTask[]>("tasks:fetchTasks", {
        extensionId,
        ...(filter?.type ? { filter: { type: filter.type } } : {}),
      })
      const folders = deps.folders.folders ?? []
      return (Array.isArray(wire) ? wire : []).map((task) =>
        task.extensionId === extensionId && provided.has(task.id)
          ? provided.get(task.id)!
          : fromWireTask(task, folders)
      )
    },
    executeTask,
    get taskExecutions(): readonly TaskExecution[] {
      return Object.freeze([...executions])
    },
    onDidStartTask: onDidStartTask.event,
    onDidEndTask: onDidEndTask.event,
    onDidStartTaskProcess: onDidStartTaskProcess.event,
    onDidEndTaskProcess: onDidEndTaskProcess.event,
  }
}
