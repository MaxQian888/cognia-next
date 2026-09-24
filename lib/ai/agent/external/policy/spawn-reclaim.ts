/**
 * Reclaiming a stale external-agent process id.
 *
 * The Rust process manager (`ExternalAgentProcessManager`, keyed by the agent's
 * persisted config id) lives in the host process, which **outlives the renderer's
 * JS realm**. Anything that restarts that realm — the white-screen watchdog
 * reloading the page, a dev Fast Refresh, a manual reload — throws away the
 * adapter's process id, peer and event listeners while the child stays
 * registered. From then on every `spawn_external_agent` for that id is rejected
 * with `"Agent {id} is already running"` and the agent is unconnectable until
 * the whole app restarts.
 *
 * Killing the orphan and respawning is the way back, and it is safe precisely
 * because a live adapter never reaches spawn: every adapter's `connect()`
 * returns early when it is already connected, so a process still registered
 * under the id has no consumer left in this realm.
 *
 * Shared by the codex-app-server, opencode and ACP adapters, which each spawn
 * over a different transport — hence the injected `spawn`/`kill`.
 */

/**
 * True for the process manager's id collision. `ExternalAgentProcessManager::
 * spawn` (crates/cognia-external-agent/src/process.rs) rejects with
 * `"Agent {id} is already running"`; the Tauri command surfaces that as a bare
 * string rather than an `Error`, so match the message.
 *
 * Note the Rust check runs *before* its `log::info!("Spawning external agent…")`,
 * so a collision leaves no trace in the native log.
 */
export function isExternalAgentAlreadyRunningError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /is already running/i.test(message)
}

export interface SpawnReclaimingOrphanOptions<T> {
  /** The process-manager key being contended for. */
  id: string
  /** Perform the spawn. Called again, once, after a successful reclaim. */
  spawn: () => Promise<T>
  /** Kill whatever is registered under `id`. */
  kill: (id: string) => Promise<unknown>
  /** Called only when an orphan was actually found, before killing it. */
  onReclaim?: (id: string) => void
}

/**
 * Spawn, reclaiming `id` if a previous process is still registered under it.
 *
 * Retries exactly once: a second collision means something is genuinely holding
 * the id (not an orphan), and must surface rather than loop.
 */
export async function spawnReclaimingOrphan<T>(
  options: SpawnReclaimingOrphanOptions<T>
): Promise<T> {
  try {
    return await options.spawn()
  } catch (error) {
    // Any other failure (ENOENT, permissions, …) is the caller's to handle.
    if (!isExternalAgentAlreadyRunningError(error)) throw error
    options.onReclaim?.(options.id)
    await options.kill(options.id)
    return await options.spawn()
  }
}
