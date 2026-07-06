/**
 * Workflow-AI plugin — `wf_run_workflow_typed`: run a PUBLISHED workflow as a
 * typed callable unit (D5), the typed successor to `wf_run_workflow_by_name`.
 *
 * Where `wf_run_workflow_by_name` emits an A2UI Approve card for IM chats, this
 * tool is the desktop/agent path: it resolves a published workflow, validates
 * the caller's `input` against the declared input schema, runs the graph, and
 * returns the typed output (validated against the output schema). It is the
 * tool the model invokes when a graph-bodied skill (`kind:"workflow"`) is
 * relevant. `requiresApproval` is true — executing a workflow is side-effecting,
 * so the SDK pops the per-tool permission gate.
 */

import type { PluginTool } from "@/types/plugin"
import { resolveWorkflowByNameOrId } from "@/lib/workflow/library/lookup"
import { getWorkflow } from "@/lib/db/workflows"
import { validateAgainstJsonSchema } from "@/lib/workflow/nodes/ai/schema-validate"
import { formatToolError } from "../store-bridge"

const PLUGIN_ID = "cognia-workflow-ai"

function summariesToBullets(candidates: Array<{ name: string; description?: string }>): string {
  return candidates
    .map((c, i) => `${i + 1}. ${c.name}${c.description ? ` — ${c.description}` : ""}`)
    .join("\n")
}

export function buildRunTypedTools(): PluginTool[] {
  return [
    {
      name: "wf_run_workflow_typed",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_run_workflow_typed",
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
      },
      execute: async (args) => {
        try {
          const name = String(args.name ?? "").trim()
          if (name.length === 0) {
            return { ok: false, error: { code: "invalid-name", message: "name is required" } }
          }

          const lookup = await resolveWorkflowByNameOrId(name)
          if (!lookup.ok && lookup.reason === "not-found") {
            return {
              ok: false,
              error: {
                code: "workflow-not-found",
                message: `No workflow named "${name}". Call wf_list_workflows to see what's available.`,
              },
            }
          }
          if (!lookup.ok && lookup.reason === "ambiguous") {
            return {
              ok: false,
              error: {
                code: "workflow-ambiguous",
                message: `"${name}" matches ${lookup.candidates.length} workflows. Ask the user to pick one:\n${summariesToBullets(lookup.candidates)}`,
                detail: { candidates: lookup.candidates },
              },
            }
          }
          if (!lookup.ok) throw new Error("unreachable")

          const workflow = await getWorkflow(lookup.workflowId)
          if (!workflow) {
            return {
              ok: false,
              error: {
                code: "workflow-not-found",
                message: `Workflow ${lookup.workflowId} not found.`,
              },
            }
          }
          if (!workflow.published) {
            return {
              ok: false,
              error: {
                code: "not-published",
                message: `Workflow "${workflow.name}" is not published as a callable unit. Open it in the editor and click Publish first.`,
              },
            }
          }

          const input = (args.input as Record<string, unknown> | undefined) ?? {}
          const inputSchema = workflow.interface?.inputSchema
          if (inputSchema && Object.keys(inputSchema).length > 0) {
            const v = validateAgainstJsonSchema(inputSchema, input)
            if (!v.ok) {
              return {
                ok: false,
                error: {
                  code: "input-schema-violation",
                  message: `input does not match the workflow's declared schema: ${v.errors.join("; ")}`,
                  detail: { schema: inputSchema },
                },
              }
            }
          }

          const { runWorkflow } = await import("@/lib/workflow/runtime/orchestrator")
          const result = await runWorkflow({
            workflow,
            trigger: {
              workflowId: workflow.id,
              kind: "trigger.manual",
              payload: { input, source: "api" },
              originAt: Date.now(),
            },
          })
          if (result.status !== "succeeded") {
            return {
              ok: false,
              error: {
                code: "run-failed",
                message: result.error?.message ?? "workflow run failed",
              },
            }
          }

          const outputSchema = workflow.interface?.outputSchema
          if (outputSchema && Object.keys(outputSchema).length > 0) {
            const v = validateAgainstJsonSchema(outputSchema, result.output)
            if (!v.ok) {
              return {
                ok: false,
                error: {
                  code: "output-schema-violation",
                  message: `the workflow output did not match its declared schema: ${v.errors.join("; ")}`,
                  detail: { output: result.output },
                },
              }
            }
          }

          return {
            ok: true,
            workflowId: workflow.id,
            workflowName: workflow.name,
            runId: result.runId,
            output: result.output,
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
  ]
}
