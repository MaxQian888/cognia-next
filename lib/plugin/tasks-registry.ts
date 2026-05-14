/**
 * Task registry — `vscode.tasks.*` backing store.
 *
 * VS Code extensions contribute task providers (npm, gulp, cargo, etc.) via
 * `vscode.tasks.registerTaskProvider`. cognia's reuse layer routes those
 * through this registry; the sidecar's `vscode-shim/tasks.ts` RPC-walls in.
 *
 * Mirrors the shape and lifecycle of `commands/registry.ts`. Each task
 * carries enough metadata for the cognia UI to render a "run task" entry
 * even before the provider's lazy `provideTasks` is called.
 *
 * Task execution is delegated to `ctx.shell.spawn` (or a custom executor
 * registered by the provider). We don't ship a terminal UI — task output
 * streams through the `vscode.terminal.output` extension point the
 * VS Code Extension Panel mounts (Phase M1.C).
 */

export interface TaskDefinition {
  type: string
  [key: string]: unknown
}

export interface TaskExecution {
  /** Stop the task. Idempotent. */
  cancel(): void
  /** Resolved when the task completes (cleanly or via cancel). */
  finished: Promise<TaskCompletionEvent>
}

export interface TaskCompletionEvent {
  taskId: string
  exitCode: number | null
  signal: string | null
  /** Captured stdout — empty when streamed elsewhere. */
  stdout?: string
  /** Captured stderr — empty when streamed elsewhere. */
  stderr?: string
  /** Wall-clock duration in ms. */
  durationMs: number
}

export type TaskExecutor = (task: ResolvedTask) => Promise<TaskExecution>

/**
 * The shape `vscode.Task` instances take after the provider resolves them.
 * Trimmed to the fields cognia's command-palette + terminal panel need.
 */
export interface ResolvedTask {
  /** Stable identifier — `${pluginId}.${name}` by convention. */
  id: string
  /** Display name surfaced in the command palette. */
  name: string
  /** Source label, e.g. `"npm"` / `"cargo"`. */
  source: string
  /** Definition object the provider hands back; surfaced for UI metadata. */
  definition: TaskDefinition
  /** Detail label (usually `${command} ${...args}`). */
  detail?: string
  /** Group (`build`, `test`, …) — mirrors `vscode.TaskGroup`. */
  group?: "build" | "test" | "clean" | "rebuild" | "none"
  /** Whether the task is a background task (long-running). */
  isBackground?: boolean
  /** Problem matcher names referenced by this task. Ignored at runtime. */
  problemMatchers?: string[]
}

export interface TaskProviderRegistration {
  type: string
  pluginId: string
  /**
   * Called when cognia needs the current list of tasks. The provider
   * returns its concrete `ResolvedTask` list; callers re-fetch when the
   * provider emits change events.
   */
  provideTasks: () => Promise<ResolvedTask[]>
  /**
   * Optional — the provider's own executor. If omitted, cognia falls back
   * to `defaultShellTaskExecutor` (spawn via ctx.shell.spawn).
   */
  executor?: TaskExecutor
}

export type TaskRegistryEventType =
  | "register-provider"
  | "unregister-provider"
  | "task-start"
  | "task-end"

export interface TaskRegistryEvent {
  type: TaskRegistryEventType
  providerType?: string
  pluginId?: string
  taskId?: string
  exitCode?: number | null
}

export type TaskRegistryListener = (event: TaskRegistryEvent) => void

const providers = new Map<string, TaskProviderRegistration>()
const listeners = new Set<TaskRegistryListener>()
const runningTasks = new Map<string, TaskExecution>()

function providerKey(type: string, pluginId: string): string {
  return `${pluginId}::${type}`
}

function emit(event: TaskRegistryEvent): void {
  queueMicrotask(() => {
    for (const fn of listeners) {
      try {
        fn(event)
      } catch (err) {
        console.warn("Task registry listener threw:", err)
      }
    }
  })
}

export function registerTaskProvider(reg: TaskProviderRegistration): () => void {
  providers.set(providerKey(reg.type, reg.pluginId), reg)
  emit({ type: "register-provider", providerType: reg.type, pluginId: reg.pluginId })
  return () => unregisterTaskProvider(reg.type, reg.pluginId)
}

export function unregisterTaskProvider(type: string, pluginId: string): void {
  const k = providerKey(type, pluginId)
  if (!providers.has(k)) return
  providers.delete(k)
  emit({ type: "unregister-provider", providerType: type, pluginId })
}

export function unregisterProvidersByPlugin(pluginId: string): number {
  let removed = 0
  for (const [k, p] of providers) {
    if (p.pluginId === pluginId) {
      providers.delete(k)
      emit({ type: "unregister-provider", providerType: p.type, pluginId })
      removed += 1
    }
  }
  return removed
}

/**
 * Aggregate tasks across every registered provider. Optionally filtered
 * by type. The first provider error degrades to an empty list for that
 * provider — one bad plugin must not poison the whole task palette.
 */
export async function fetchTasks(filter?: { type?: string }): Promise<ResolvedTask[]> {
  const out: ResolvedTask[] = []
  for (const provider of providers.values()) {
    if (filter?.type && provider.type !== filter.type) continue
    try {
      const tasks = await provider.provideTasks()
      out.push(...tasks)
    } catch (err) {
      console.warn(
        `[tasks-registry] provider ${provider.type} (${provider.pluginId}) threw during provideTasks:`,
        err
      )
    }
  }
  return out
}

/**
 * Run a task. Uses the provider's executor if it declared one, otherwise
 * falls back to the cognia `defaultShellTaskExecutor` (set by the
 * renderer's bootstrap so this module stays test-friendly).
 */
export async function executeTask(task: ResolvedTask): Promise<TaskExecution> {
  // Look up the provider whose `type` matches. Cross-plugin lookup is
  // intentional — the task palette doesn't know who registered the type.
  const providerEntry = [...providers.values()].find((p) => p.type === task.definition.type)
  const executor =
    providerEntry?.executor ??
    defaultExecutor ??
    (() =>
      Promise.reject(
        new Error(
          `No executor available for task type "${task.definition.type}". Did you call setDefaultTaskExecutor()?`
        )
      ))
  const execution = await executor(task)
  runningTasks.set(task.id, execution)
  emit({ type: "task-start", taskId: task.id })
  void execution.finished.then((event) => {
    runningTasks.delete(task.id)
    emit({ type: "task-end", taskId: task.id, exitCode: event.exitCode })
  })
  return execution
}

export function getRunningTask(taskId: string): TaskExecution | undefined {
  return runningTasks.get(taskId)
}

export function cancelTask(taskId: string): boolean {
  const exec = runningTasks.get(taskId)
  if (!exec) return false
  exec.cancel()
  return true
}

export function subscribeTaskRegistry(listener: TaskRegistryListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ────────────────────────────────────────────────────────────────────────
// Default shell executor pluggable point
// ────────────────────────────────────────────────────────────────────────

let defaultExecutor: TaskExecutor | undefined

/**
 * Install the fallback task executor used when a provider didn't supply
 * its own. The renderer's bootstrap calls this with an executor that wraps
 * `ctx.shell.spawn` + the `vscode.terminal.output` panel.
 */
export function setDefaultTaskExecutor(executor: TaskExecutor): void {
  defaultExecutor = executor
}

export function clearDefaultTaskExecutor(): void {
  defaultExecutor = undefined
}

export function __resetTaskRegistryForTesting(): void {
  providers.clear()
  listeners.clear()
  runningTasks.clear()
  defaultExecutor = undefined
}
