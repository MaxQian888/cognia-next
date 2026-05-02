/**
 * Background agent lifecycle.
 *
 * Plugins can fire-and-forget agents via the plugin Agent API; the
 * runtime tracks them here so they can be cancelled later. The manager
 * is intentionally minimal: it stores the AbortController for each
 * agent and exposes `cancelAgent(id)` to abort it.
 */

interface BackgroundAgentEntry {
  id: string
  controller: AbortController
  startedAt: number
  pluginId?: string
  label?: string
}

class BackgroundAgentManager {
  private entries = new Map<string, BackgroundAgentEntry>()

  /**
   * Register a fresh agent run. Returns an `AbortSignal` plugins should
   * thread into their `executeAgent` call.
   */
  registerAgent(id: string, options: { pluginId?: string; label?: string } = {}): AbortSignal {
    const controller = new AbortController()
    this.entries.set(id, {
      id,
      controller,
      startedAt: Date.now(),
      pluginId: options.pluginId,
      label: options.label,
    })
    return controller.signal
  }

  /** Mark the agent finished — drops the entry without aborting. */
  finishAgent(id: string): boolean {
    return this.entries.delete(id)
  }

  cancelAgent(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) return false
    entry.controller.abort()
    this.entries.delete(id)
    return true
  }

  cancelByPlugin(pluginId: string): number {
    let cancelled = 0
    for (const entry of [...this.entries.values()]) {
      if (entry.pluginId === pluginId) {
        entry.controller.abort()
        this.entries.delete(entry.id)
        cancelled += 1
      }
    }
    return cancelled
  }

  list(): Array<Pick<BackgroundAgentEntry, "id" | "startedAt" | "pluginId" | "label">> {
    return [...this.entries.values()].map(({ id, startedAt, pluginId, label }) => ({
      id,
      startedAt,
      pluginId,
      label,
    }))
  }
}

let singleton: BackgroundAgentManager | null = null

export function getBackgroundAgentManager(): BackgroundAgentManager {
  if (!singleton) singleton = new BackgroundAgentManager()
  return singleton
}

/** Test-only escape hatch. */
export function __resetBackgroundAgentManagerForTesting(): void {
  singleton = null
}
