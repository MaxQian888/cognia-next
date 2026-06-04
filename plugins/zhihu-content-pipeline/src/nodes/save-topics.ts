/**
 * `save-topics` — a custom workflow node that persists the ranking step's
 * candidate list into the plugin's `topics` Dexie table.
 *
 * Registered via `ctx.workflow.registerNode` (the host auto-prefixes the kind
 * to `zhihu-content-pipeline.save-topics` and adds the editor palette entry —
 * NO core node-kind union edit). The executor closes over the `PluginDexieAPI`
 * handle captured in `activate()` because `StepExecutionContext` carries no
 * `ctx.dexie`. This is the front workflow's terminal step: candidates land in
 * the table, the run ends, and the review panel surfaces them for the 选题 gate.
 */

import type { PluginNodeDef } from "@/types/plugin/plugin-workflow"
import type { PluginDexieAPI } from "@/types/plugin"
import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import { createPipelineDb, parseCandidates } from "../db/tables"

/** Unprefixed kind — the host prefixes the pluginId. */
export const SAVE_TOPICS_KIND = "save-topics"

interface SaveTopicsParams {
  /** The ranking step's output (JSON array / wrapper / fenced block / object). */
  candidates?: unknown
  /** Provenance label stored on each row (e.g. "zhihu-hot"). */
  source?: string
}

/** Build the node bound to a live Dexie handle. */
export function makeSaveTopicsNode(dexie: PluginDexieAPI): PluginNodeDef {
  const db = createPipelineDb(dexie)

  async function execute(ctx: StepExecutionContext): Promise<StepExecutionResult> {
    const params = (ctx.params ?? {}) as SaveTopicsParams
    const source =
      typeof params.source === "string" && params.source.trim() ? params.source.trim() : "pipeline"
    const candidates = parseCandidates(params.candidates)
    if (candidates.length === 0) {
      ctx.log("warn", "save-topics: no candidates parsed from upstream output — nothing saved")
      return { output: { saved: 0, topicIds: [] } }
    }
    const rows = await db.saveTopics(candidates, source)
    ctx.log("info", `save-topics: saved ${rows.length} candidate topic(s)`)
    return { output: { saved: rows.length, topicIds: rows.map((r) => r.id) } }
  }

  return {
    kind: SAVE_TOPICS_KIND,
    typeVersion: 1,
    category: "plugin",
    label: "Save Zhihu Topics",
    description:
      "Persist the ranking step's candidate topics into the pipeline's topics table for the 选题 review gate.",
    iconName: "list-checks",
    keywords: ["zhihu", "topics", "candidates", "save"],
    retryable: false,
    paramsSchema: {
      type: "object",
      properties: {
        candidates: {
          description: "Ranking step output: JSON array of { title, url?, reason?, score? }.",
        },
        source: {
          type: "string",
          description: "Provenance label stored on each row.",
        },
      },
      required: ["candidates"],
      additionalProperties: false,
    },
    defaultParams: {
      // No `.out` wrapper — `upstream[id]` is the raw executor output.
      candidates: "{{ $node['rank'].completion }}",
      source: "zhihu-hot",
    },
    execute,
  }
}
