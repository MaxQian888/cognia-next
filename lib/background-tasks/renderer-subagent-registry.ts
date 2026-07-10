import {
  BackgroundTaskRegistry,
  backgroundTaskInterruptedMessage,
  type BackgroundTaskControls,
  type BackgroundTaskJournalProjection,
  type BackgroundTaskSettleInfo,
  type BackgroundTaskUsage,
  type BackgroundTaskStartMeta,
} from "@/lib/background-tasks/registry-core"
import {
  createDexieBackgroundTaskJournal,
  getBackgroundTaskRecord,
  interruptBackgroundTasksOnBoot,
} from "@/lib/db/background-tasks"
import type {
  PluginDispatchErrorEnvelope,
  PluginSubagentDispatchResult,
} from "@/types/plugin/plugin-agent-sdk"

const journal = createDexieBackgroundTaskJournal()

/**
 * Settle listener seam (inversion so this lib module never imports stores or
 * hooks — same pattern as the steer runtime). The chat-side background-result
 * runtime registers itself here to drive completion re-injection +
 * notifications when a background run settles.
 */
export type RendererBackgroundSettleListener = (
  runId: string,
  meta: BackgroundTaskStartMeta,
  settle: BackgroundTaskSettleInfo
) => void

let settleListener: RendererBackgroundSettleListener | undefined

export function setRendererBackgroundSettleListener(
  listener: RendererBackgroundSettleListener | undefined
): void {
  settleListener = listener
}

/**
 * Journal projection shared by background (registry) and foreground (journal-
 * only) dispatch tracking. A failed run keeps its partial output as
 * `resultText` and its envelope message as `error` — "mark failed but keep the
 * last output" (Claude Code background-error parity). Cancelled/rejected runs
 * are error rows too, so boot reconciliation never mistakes them for running.
 */
function projectDispatchResult(
  value: PluginSubagentDispatchResult
): BackgroundTaskJournalProjection {
  const failed =
    value.finishReason === "error" ||
    value.finishReason === "cancelled" ||
    value.finishReason === "rejected"
  return {
    text: value.errorEnvelope?.partialText ?? value.text,
    ...(value.usage ? { usage: value.usage } : {}),
    ...(failed ? { error: value.errorEnvelope?.message ?? value.text } : {}),
  }
}

const registry = new BackgroundTaskRegistry<PluginSubagentDispatchResult>({
  journal,
  projectForJournal: projectDispatchResult,
  onSettle: (runId, meta, settle) => settleListener?.(runId, meta, settle),
})

export type RendererBackgroundTaskMeta = BackgroundTaskStartMeta & { host: "renderer" }

export function startRendererBackgroundRun(
  runId: string,
  meta: RendererBackgroundTaskMeta,
  promise: Promise<PluginSubagentDispatchResult>,
  controls?: BackgroundTaskControls
): void {
  registry.start(runId, { ...meta, mode: "background" }, promise, controls)
}

/**
 * Journal-only tracking for a FOREGROUND dispatch: writes the same Dexie rows
 * as a background run (so a renderer reload reconciles it to `interrupted` on
 * boot) but never enters the in-memory collectable registry — foreground
 * results are awaited inline by the parent turn, never collected.
 */
export function journalRendererForegroundRun(
  runId: string,
  meta: RendererBackgroundTaskMeta,
  promise: Promise<PluginSubagentDispatchResult>
): void {
  swallow(() => journal.recordStart({ runId, ...meta, mode: "foreground", status: "running" }))
  promise.then(
    (value) => {
      const projection = projectDispatchResult(value)
      swallow(() =>
        journal.recordSettle(runId, {
          status: projection.error ? "error" : "done",
          settledAt: Date.now(),
          resultText: projection.text,
          ...(projection.error ? { error: projection.error } : {}),
          ...(projection.usage ? { usage: projection.usage } : {}),
        })
      )
    },
    (err) => {
      // The dispatch chain collapses errors into resolved results; this branch
      // is belt-and-braces for an unexpected rejection.
      swallow(() =>
        journal.recordSettle(runId, {
          status: "error",
          settledAt: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        })
      )
    }
  )
}

export function hasRendererBackgroundRun(runId: string): boolean {
  return registry.has(runId)
}

/**
 * Collect a background run's result. IDEMPOTENT: after the live entry is
 * consumed, every later collect answers from the journal (results stay
 * collectable until pruned) — a model that re-collects, or collects after a
 * completion notice, always gets the result instead of "not found".
 */
export async function collectRendererBackgroundResult(
  runId: string
): Promise<PluginSubagentDispatchResult | undefined> {
  try {
    const live = await registry.collect(runId)
    if (live) {
      markCollected(runId)
      return live
    }
  } catch (err) {
    markCollected(runId)
    return errorResult(runId, errorMessage(err), { code: "unknown", retryable: false })
  }

  let record: Awaited<ReturnType<typeof getBackgroundTaskRecord>>
  try {
    record = await getBackgroundTaskRecord(runId)
  } catch {
    return undefined
  }
  // Only subagent rows are collectable through dispatch_agent — plugin-agent /
  // team-delegation journal rows share the table but are never model-facing.
  if (!record || record.host !== "renderer" || record.kind !== "subagent") return undefined
  if (record.status === "done") {
    markCollected(runId)
    const usage = pluginUsage(record.usage)
    return {
      text: record.resultText ?? "",
      channel: "text",
      toolsAvailable: false,
      runId,
      ...(usage ? { usage } : {}),
    }
  }
  if (record.status === "error") {
    markCollected(runId)
    return errorResult(runId, record.error ?? record.resultText ?? "Background run failed.", {
      code: "unknown",
      retryable: false,
      ...(record.resultText ? { partialText: record.resultText } : {}),
    })
  }
  if (record.status === "interrupted") {
    markCollected(runId)
    return errorResult(runId, backgroundTaskInterruptedMessage(runId), {
      code: "interrupted",
      retryable: false,
      ...(record.resultText ? { partialText: record.resultText } : {}),
    })
  }
  return undefined
}

/** Best-effort bookkeeping: stamp the latest successful collect. */
function markCollected(runId: string): void {
  swallow(() => journal.update(runId, { collectedAt: Date.now() }))
}

export function listRendererBackgroundRuns() {
  return registry.list()
}

export function countRunningRendererBackgroundRuns(): number {
  return registry.countRunning()
}

export function cancelRendererBackgroundRun(runId: string): boolean {
  return registry.cancel(runId)
}

export async function interruptRendererBackgroundTasksOnBoot(options: { now?: () => number } = {}) {
  return interruptBackgroundTasksOnBoot(options)
}

export function __clearRendererBackgroundRunsForTesting(): void {
  registry.__clearForTesting()
  settleListener = undefined
}

/** Reconstruct an error-shaped result (journal fallback / thrown collect). */
function errorResult(
  runId: string,
  text: string,
  envelope: Omit<PluginDispatchErrorEnvelope, "message">
): PluginSubagentDispatchResult {
  return {
    text,
    channel: "text",
    toolsAvailable: false,
    runId,
    finishReason: "error",
    errorEnvelope: { ...envelope, message: text },
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function swallow(write: () => void | Promise<void>): void {
  try {
    const maybe = write()
    if (maybe && typeof (maybe as Promise<void>).catch === "function") {
      ;(maybe as Promise<void>).catch(() => undefined)
    }
  } catch {
    // Journal writes are best-effort.
  }
}

function pluginUsage(
  usage: BackgroundTaskUsage | undefined
): PluginSubagentDispatchResult["usage"] | undefined {
  if (
    usage?.inputTokens === undefined ||
    usage.outputTokens === undefined ||
    usage.totalTokens === undefined
  ) {
    return undefined
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  }
}
