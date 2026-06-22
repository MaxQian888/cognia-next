import {
  BackgroundTaskRegistry,
  backgroundTaskInterruptedMessage,
  type BackgroundTaskControls,
  type BackgroundTaskUsage,
  type BackgroundTaskStartMeta,
} from "@/lib/background-tasks/registry-core"
import {
  createDexieBackgroundTaskJournal,
  getBackgroundTaskRecord,
  interruptBackgroundTasksOnBoot,
} from "@/lib/db/background-tasks"
import type { PluginSubagentDispatchResult } from "@/types/plugin/plugin-agent-sdk"

const registry = new BackgroundTaskRegistry<PluginSubagentDispatchResult>({
  journal: createDexieBackgroundTaskJournal(),
  projectForJournal: (value) => ({
    text: value.text,
    ...(value.usage ? { usage: value.usage } : {}),
    ...(value.finishReason === "error" ? { error: value.text } : {}),
  }),
})
const collectedRunIds = new Set<string>()

export type RendererBackgroundTaskMeta = BackgroundTaskStartMeta & { host: "renderer" }

export function startRendererBackgroundRun(
  runId: string,
  meta: RendererBackgroundTaskMeta,
  promise: Promise<PluginSubagentDispatchResult>,
  controls?: BackgroundTaskControls
): void {
  registry.start(runId, meta, promise, controls)
}

export function hasRendererBackgroundRun(runId: string): boolean {
  return registry.has(runId)
}

export async function collectRendererBackgroundResult(
  runId: string
): Promise<PluginSubagentDispatchResult | undefined> {
  if (collectedRunIds.has(runId)) return undefined
  try {
    const live = await registry.collect(runId)
    if (live) {
      collectedRunIds.add(runId)
      return live
    }
  } catch (err) {
    collectedRunIds.add(runId)
    return errorEnvelope(runId, errorMessage(err))
  }

  let record: Awaited<ReturnType<typeof getBackgroundTaskRecord>>
  try {
    record = await getBackgroundTaskRecord(runId)
  } catch {
    return undefined
  }
  if (!record || record.host !== "renderer") return undefined
  if (record.status === "done") {
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
    return errorEnvelope(runId, record.error ?? record.resultText ?? "Background run failed.")
  }
  if (record.status === "interrupted") {
    return errorEnvelope(runId, backgroundTaskInterruptedMessage(runId))
  }
  return undefined
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

export async function interruptRendererBackgroundTasksOnBoot(
  options: { now?: () => number } = {}
): Promise<void> {
  await interruptBackgroundTasksOnBoot(options)
}

export function __clearRendererBackgroundRunsForTesting(): void {
  registry.__clearForTesting()
  collectedRunIds.clear()
}

function errorEnvelope(runId: string, text: string): PluginSubagentDispatchResult {
  return {
    text,
    channel: "text",
    toolsAvailable: false,
    runId,
    finishReason: "error",
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
