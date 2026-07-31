/**
 * Background agent lifecycle — an API-compatible facade over the durable
 * `BackgroundTaskRegistry`.
 *
 * Plugins fire-and-forget agents via the plugin Agent API; team delegations
 * ride the same tracker. Historically this was a bare `Map<id,
 * AbortController>` — no journal, no boot reconciliation, no UI — so a
 * renderer reload orphaned every in-flight agent silently. It now fronts the
 * same Dexie-journaled registry the background subagent runs use: rows appear
 * in the Job Center, orphaned `running` rows reconcile to `interrupted` on
 * boot (the existing initializer covers all kinds), and cancellation still
 * works through the same `registerAgent → AbortSignal` contract.
 *
 * The legacy call shape is preserved: `registerAgent` returns an AbortSignal
 * synchronously, `finishAgent`/`cancelAgent` return booleans, `list()` keeps
 * its projection. `finishAgent` optionally carries the run's outcome so the
 * journal row records result text/usage (or the error).
 */

import {
  BackgroundTaskRegistry,
  type BackgroundTaskKind,
  type BackgroundTaskUsage,
} from "@/lib/background-tasks/registry-core"
import { createDexieBackgroundTaskJournal } from "@/lib/db/background-tasks"

/** Terminal outcome the facade projects into the journal. */
export interface BackgroundAgentOutcome {
  text: string
  usage?: BackgroundTaskUsage
  error?: string
}

export type BackgroundAgentKind = Extract<BackgroundTaskKind, "plugin-agent" | "team-delegation">

export interface RegisterAgentOptions {
  pluginId?: string
  label?: string
  /** Journal row kind. Defaults to `plugin-agent`. */
  kind?: BackgroundAgentKind
  /** Originating chat session, when the caller has one. */
  sessionId?: string
  /** The run's prompt, for faithful Job Center display. */
  prompt?: string
}

interface LiveEntry {
  id: string
  controller: AbortController
  resolve: (outcome: BackgroundAgentOutcome) => void
  settled: boolean
  startedAt: number
  pluginId?: string
  label?: string
}

class BackgroundAgentManager {
  private readonly live = new Map<string, LiveEntry>()
  private readonly registry = new BackgroundTaskRegistry<BackgroundAgentOutcome>({
    journal: createDexieBackgroundTaskJournal(),
    projectForJournal: (value) => ({
      text: value.text,
      ...(value.usage ? { usage: value.usage } : {}),
      ...(value.error ? { error: value.error } : {}),
    }),
  })

  /**
   * Register a fresh agent run. Returns an `AbortSignal` plugins should
   * thread into their `executeAgent` call.
   */
  registerAgent(id: string, options: RegisterAgentOptions = {}): AbortSignal {
    const controller = new AbortController()
    let resolve!: (outcome: BackgroundAgentOutcome) => void
    const parked = new Promise<BackgroundAgentOutcome>((res) => {
      resolve = res
    })
    const entry: LiveEntry = {
      id,
      controller,
      resolve,
      settled: false,
      startedAt: Date.now(),
      ...(options.pluginId !== undefined ? { pluginId: options.pluginId } : {}),
      ...(options.label !== undefined ? { label: options.label } : {}),
    }
    this.live.set(id, entry)
    this.registry.start(
      id,
      {
        kind: options.kind ?? "plugin-agent",
        subagentId: options.label ?? id,
        prompt: options.prompt ?? options.label ?? id,
        sessionId: options.sessionId ?? "",
        host: "renderer",
        startedAt: entry.startedAt,
        mode: "background",
        ...(options.pluginId ? { pluginId: options.pluginId } : {}),
        ...(options.label ? { label: options.label } : {}),
      },
      parked,
      { cancel: () => controller.abort() }
    )
    return controller.signal
  }

  /**
   * Mark the agent finished. Settle-once: later calls (e.g. a `finally`
   * backstop after an outcome-carrying settle) are no-ops. `outcome` lets the
   * journal row record the run's text/usage — or its error.
   */
  finishAgent(id: string, outcome?: Partial<BackgroundAgentOutcome>): boolean {
    return this.settle(id, {
      text: outcome?.text ?? "",
      ...(outcome?.usage ? { usage: outcome.usage } : {}),
      ...(outcome?.error ? { error: outcome.error } : {}),
    })
  }

  /** Abort a running agent; journals it as a cancelled (error) row. */
  cancelAgent(id: string): boolean {
    const entry = this.live.get(id)
    if (!entry) return false
    // Registry.cancel flags the entry cancelled + fires the abort hook.
    this.registry.cancel(id)
    entry.controller.abort()
    return this.settle(id, { text: "", error: "Cancelled." })
  }

  /** Abort every running agent owned by a plugin (bulk disable cleanup). */
  cancelByPlugin(pluginId: string): number {
    let cancelled = 0
    for (const [id, entry] of [...this.live]) {
      if (entry.pluginId === pluginId && this.cancelAgent(id)) cancelled += 1
    }
    return cancelled
  }

  list(): Array<{ id: string; startedAt: number; pluginId?: string; label?: string }> {
    return [...this.live.values()].map(({ id, startedAt, pluginId, label }) => ({
      id,
      startedAt,
      pluginId,
      label,
    }))
  }

  private settle(id: string, outcome: BackgroundAgentOutcome): boolean {
    const entry = this.live.get(id)
    if (!entry || entry.settled) return false
    entry.settled = true
    entry.resolve(outcome)
    this.live.delete(id)
    // Evict the registry's in-memory entry once settled — the journal row is
    // the durable history (Job Center); the live map should not grow forever.
    void this.registry.collect(id).catch(() => undefined)
    return true
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
