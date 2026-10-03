/**
 * Supervised restart for VS Code extension hosts.
 *
 * Each extension runs in its own Node host. When one exits unexpectedly the
 * Rust side drops it from its table and reports `host:exited`; this decides
 * whether and when to bring it back, through the plugin manager's normal
 * reload (a fresh generation, a fresh activation).
 *
 * Policy, as the LSP service uses for language servers: wait 1 s·2ⁿ (capped
 * at 30 s) before restart n, give up after {@link MAX_RESTARTS}, and forget
 * earlier crashes once a host has stayed up for {@link STABLE_UPTIME_MS}. A
 * host that gives up is `crashed`: the plugin is marked errored with the
 * reason, which is what the plugin list shows, and it stays down until the
 * user enables it again.
 */

export const RESTART_BASE_MS = 1_000
export const RESTART_CAP_MS = 30_000
export const MAX_RESTARTS = 5
export const STABLE_UPTIME_MS = 5 * 60_000

export type VscodeHostStatus = "running" | "restarting" | "crashed"

export interface VscodeHostExit {
  code: number | null
  signal: number | null
  intentional: boolean
}

export interface VscodeHostState {
  status: VscodeHostStatus
  /** Restarts since the host last stayed up for `STABLE_UPTIME_MS`. */
  restarts: number
  lastExit?: VscodeHostExit
  /** When the pending restart runs (`restarting` only). */
  nextAttemptAt?: number
}

export interface HostSupervisorDependencies {
  restart(pluginId: string): Promise<void>
  /** Mark the plugin errored (`null` clears it). */
  setError(pluginId: string, message: string | null): void
  now(): number
  setTimer(callback: () => void, delayMs: number): unknown
  clearTimer(handle: unknown): void
}

export function restartDelay(attempt: number): number {
  return Math.min(RESTART_BASE_MS * 2 ** attempt, RESTART_CAP_MS)
}

export function describeExit(exit: VscodeHostExit): string {
  if (exit.signal !== null) return `signal ${exit.signal}`
  return exit.code === null ? "an unknown status" : `code ${exit.code}`
}

export function createHostSupervisor(deps: HostSupervisorDependencies) {
  type Tracked = VscodeHostState & { startedAt?: number; timer?: unknown }
  const states = new Map<string, Tracked>()
  const listeners = new Set<() => void>()
  const changed = () => {
    for (const listener of listeners) listener()
  }

  /** Count one failed run and either schedule the next restart or give up. */
  function fail(pluginId: string, exit: VscodeHostExit, restarts: number): void {
    if (restarts >= MAX_RESTARTS) {
      states.set(pluginId, { status: "crashed", restarts, lastExit: exit })
      deps.setError(
        pluginId,
        `The VS Code extension host stopped with ${describeExit(exit)} and was restarted ${MAX_RESTARTS} times; it stays stopped until the plugin is enabled again.`
      )
      changed()
      return
    }
    const delay = restartDelay(restarts)
    const timer = deps.setTimer(() => {
      deps.restart(pluginId).catch(() => {
        // A restart that cannot even start is the next failed run. The
        // reload's own activation reports `onStarted` when it does start.
        fail(pluginId, exit, restarts + 1)
      })
    }, delay)
    states.set(pluginId, {
      status: "restarting",
      restarts: restarts + 1,
      lastExit: exit,
      nextAttemptAt: deps.now() + delay,
      timer,
    })
    changed()
  }

  return {
    /** A host is up: record when, so a long-lived one earns a clean slate. */
    onStarted(pluginId: string): void {
      const previous = states.get(pluginId)
      states.set(pluginId, {
        status: "running",
        restarts: previous?.restarts ?? 0,
        lastExit: previous?.lastExit,
        startedAt: deps.now(),
      })
      deps.setError(pluginId, null)
      changed()
    },

    onExited(pluginId: string, exit: VscodeHostExit): void {
      const previous = states.get(pluginId)
      if (exit.intentional) {
        // Unload, disable or replacement: not a crash, nothing to restart.
        if (previous?.timer !== undefined) deps.clearTimer(previous.timer)
        states.delete(pluginId)
        changed()
        return
      }
      // Already handling this host's crash, or given up on it.
      if (previous?.status === "restarting" || previous?.status === "crashed") return
      const stable =
        previous?.startedAt !== undefined && deps.now() - previous.startedAt >= STABLE_UPTIME_MS
      fail(pluginId, exit, stable ? 0 : (previous?.restarts ?? 0))
    },

    state(pluginId: string): VscodeHostState | undefined {
      const state = states.get(pluginId)
      if (!state) return undefined
      const { startedAt: _startedAt, timer: _timer, ...visible } = state
      return visible
    },

    /** The user enabled the plugin again: forget the crash history. */
    reset(pluginId: string): void {
      const state = states.get(pluginId)
      if (state?.timer !== undefined) deps.clearTimer(state.timer)
      states.delete(pluginId)
      changed()
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    dispose(): void {
      for (const state of states.values()) {
        if (state.timer !== undefined) deps.clearTimer(state.timer)
      }
      states.clear()
      listeners.clear()
    },
  }
}

export type HostSupervisor = ReturnType<typeof createHostSupervisor>

let defaultSupervisor: HostSupervisor | null = null

/**
 * The app's supervisor: restarts go through `PluginManager.reloadPlugin`, and
 * giving up marks the plugin errored in the plugin store. Imported lazily so
 * this module stays free of the manager's import graph.
 */
export function getVscodeHostSupervisor(): HostSupervisor {
  defaultSupervisor ??= createHostSupervisor({
    restart: async (pluginId) => {
      const { getPluginManager } = await import("@/lib/plugin/core/manager")
      await getPluginManager().reloadPlugin(pluginId, "vscode-host-crash")
    },
    setError: (pluginId, message) => {
      void import("@/stores/plugin-runtime/plugin-store").then(({ usePluginStore }) => {
        if (usePluginStore.getState().plugins[pluginId]) {
          usePluginStore.getState().setPluginError(pluginId, message)
        }
      })
    },
    now: () => Date.now(),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  })
  return defaultSupervisor
}
