/**
 * The shared typed workflow runner — name + tool definition, dependency-free.
 *
 * Publishing a workflow does NOT register a per-workflow tool: every
 * graph-bodied skill (`kind:"workflow"`) routes through this ONE runner. The
 * primary registration lives in the `cognia-workflow-ai` plugin
 * (`plugins/workflow-ai/src/tools/run-typed-tools.ts`); when that plugin is
 * disabled, the skills→tools projection in `lib/claude/build-options.ts`
 * appends this manifest entry itself and `lib/claude/plugin-tool-ipc.ts`
 * executes it via `lib/workflow/publish/run-workflow-typed-tool.ts`.
 *
 * Kept free of runtime imports on purpose — `plugin-tool-ipc.ts` (also used by
 * the CLI host) must be able to import the NAME without dragging Dexie or the
 * workflow orchestrator into its module graph.
 */

import type { PluginToolDef } from "@/types/plugin"

export const WORKFLOW_RUNNER_TOOL_NAME = "wf_run_workflow_typed"

/** Plugin id that owns the primary registration of the runner tool. */
export const WORKFLOW_AI_PLUGIN_ID = "cognia-workflow-ai"

/**
 * Tool definition shared by the plugin registration and the skills→tools
 * fallback manifest entry. Single source — the two surfaces must never drift,
 * or the model would see two contracts for the same tool name.
 */
export const WORKFLOW_RUNNER_TOOL_DEFINITION: PluginToolDef = {
  name: WORKFLOW_RUNNER_TOOL_NAME,
  description:
    "Run a PUBLISHED workflow (by display name or id) as a typed callable unit and return its typed output. Pass `input` as an object matching the workflow's declared input schema (surfaced to the graph as $trigger.payload). Returns a structured error with candidates when the name is ambiguous/unknown, when the workflow is not published, or when the input/output fails the declared schema. Use this to execute a workflow deterministically instead of performing its steps yourself.",
  category: "workflow",
  requiresApproval: true,
  parametersSchema: {
    type: "object",
    required: ["name"],
    properties: {
      name: {
        type: "string",
        description: "Published workflow display name (case-insensitive) or id.",
      },
      input: {
        type: "object",
        description:
          "Run payload matching the workflow's declared input schema. Surfaced as $trigger.payload.",
        additionalProperties: true,
      },
    },
  },
}
