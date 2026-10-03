/**
 * Task registry: the task providers VS Code extensions register with
 * `vscode.tasks.registerTaskProvider`, so `vscode.tasks.fetchTasks` in any
 * extension sees every extension's tasks.
 *
 * Mirrors the shape and lifecycle of `commands/registry.ts`. A task crosses
 * as the host's wire form (`sidecar/vscode-ext-host/src/vscode-shim/tasks.ts`,
 * `WireTask`); this registry passes it through without reading more than its
 * type. Running a task happens in the extension's own host, which opens a
 * terminal for it, not here.
 */

export interface TaskDefinition {
  type: string
  [key: string]: unknown
}

/**
 * A task as a provider hands it over (the host's `WireTask`): who provided
 * it, its name, source and definition, and how it runs.
 */
export interface ResolvedTask {
  /** `${extension id}/${source}/${name}`. */
  id: string
  /** The extension that provided it. */
  extensionId?: string
  /** Display name. */
  name: string
  /** Source label, e.g. `"npm"` / `"cargo"`. */
  source: string
  definition: TaskDefinition
  detail?: string
  /** `TaskGroup.id`: `build`, `test`, `clean` or `rebuild`. */
  group?: string
  isBackground?: boolean
  /** Problem matcher names. Cognia makes no diagnostics from them. */
  problemMatchers?: string[]
  /** Global, workspace, or a workspace folder (`{ folder: uri }`). */
  scope?: unknown
  /** How it runs: shell, process or custom, as the host describes it. */
  execution?: unknown
  presentationOptions?: Record<string, unknown>
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
}

export type TaskRegistryEventType = "register-provider" | "unregister-provider"

export interface TaskRegistryEvent {
  type: TaskRegistryEventType
  providerType?: string
  pluginId?: string
}

export type TaskRegistryListener = (event: TaskRegistryEvent) => void

const providers = new Map<string, TaskProviderRegistration>()
const listeners = new Set<TaskRegistryListener>()

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

export function subscribeTaskRegistry(listener: TaskRegistryListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function __resetTaskRegistryForTesting(): void {
  providers.clear()
  listeners.clear()
}
