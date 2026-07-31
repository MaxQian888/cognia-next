/**
 * Small-model "work content" title for a workflow run.
 *
 * Fire-and-forget, mirroring the chat title pipeline: once a run reaches a
 * terminal state the orchestrator calls `generateWorkflowRunTitle(runId)`,
 * which asks the cheap utility model for a short title describing *what this
 * run did* (built from the workflow name/description + the run input, plus the
 * output/error as the result) and stores it on the run row. The agent-runs
 * view prefers this over the static workflow name. Reuses `runTitleTask` so
 * the gate / smoothing / freshness-recheck behave exactly like chat titles.
 */

import { getDb } from "@/lib/db/schema"
import { useSettingsStore } from "@/stores/settings"
import { runTitleTask } from "@/lib/ai/generation/run-title-task"

/** Serialise an arbitrary payload into a short text preview for the prompt. */
function preview(value: unknown, max: number): string {
  if (value == null) return ""
  if (typeof value === "string") return value.slice(0, max)
  return safeStringify(value).slice(0, max)
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

/**
 * Generate + persist the work title for a terminal workflow run. No-op (and
 * never throws) when titling is disabled, the run is missing, the run title
 * was manually set, or no utility model is available.
 */
export async function generateWorkflowRunTitle(runId: string): Promise<string | null> {
  try {
    const runRow = await getDb().workflowRuns.get(runId)
    if (!runRow || runRow.titleAuto === false) return null

    const settings = useSettingsStore.getState().settings
    const titleCfg = settings?.conversationTitle
    if (titleCfg?.enabled === false) return null

    const wf = runRow.workflowSnapshot
    const sourceParts = [wf?.name, wf?.description, preview(runRow.input, 1500)]
      .filter((s): s is string => !!s && s.trim().length > 0)
      .join("\n")
    const resultText =
      runRow.status === "failed"
        ? preview(runRow.error?.message, 500)
        : preview(runRow.output, 1000)

    return await runTitleTask({
      session: null,
      appSettings: settings,
      override: titleCfg,
      featureId: "workflow-run-title",
      sourceText: sourceParts,
      resultText: resultText || undefined,
      locale: settings?.language,
      kind: "work",
      currentTitle: runRow.title,
      isStillAuto: async () => {
        const fresh = await getDb().workflowRuns.get(runId)
        return !fresh || fresh.titleAuto !== false
      },
      persist: async (title) => {
        await getDb().workflowRuns.update(runId, { title, titleAuto: true })
      },
    })
  } catch {
    return null
  }
}
