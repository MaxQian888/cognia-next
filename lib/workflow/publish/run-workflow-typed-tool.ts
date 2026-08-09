/**
 * Shared execution core for the typed workflow runner (D5).
 *
 * Resolves a published workflow by name/id, validates the caller's `input`
 * against the declared input schema, runs the graph, and validates the output
 * against the declared output schema. Extracted from
 * `plugins/workflow-ai/src/tools/run-typed-tools.ts` so the same behavior
 * backs BOTH surfaces:
 *   1. the `cognia-workflow-ai` plugin registration (primary), and
 *   2. the skills→tools fallback in `lib/claude/plugin-tool-ipc.ts` used when
 *      a `kind:"workflow"` skill is active but the plugin is disabled.
 *
 * Every failure mode returns a structured `{ ok: false, error }` envelope —
 * never throws — so the model can read the reason and self-correct.
 */

import { resolveWorkflowByNameOrId } from "@/lib/workflow/library/lookup"
import { validateAgainstJsonSchema } from "@/lib/workflow/nodes/ai/schema-validate"
import {
  executeDeployedWorkflow,
  WorkflowAdmissionError,
} from "@/lib/workflow/runtime/execution-authority"

export type RunWorkflowTypedResult =
  | {
      ok: true
      workflowId: string
      workflowName: string
      runId: string
      output: unknown
    }
  | {
      ok: false
      error: { code: string; message: string; detail?: unknown }
    }

function summariesToBullets(candidates: Array<{ name: string; description?: string }>): string {
  return candidates
    .map((c, i) => `${i + 1}. ${c.name}${c.description ? ` — ${c.description}` : ""}`)
    .join("\n")
}

export async function executeRunWorkflowTyped(
  args: Record<string, unknown>
): Promise<RunWorkflowTypedResult> {
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

    const input = (args.input as Record<string, unknown> | undefined) ?? {}
    const execution = await executeDeployedWorkflow({
      workflowId: lookup.workflowId,
      entrypoint: "agent-tool",
      caller: "wf_run_workflow_typed",
      ...(typeof args.idempotencyKey === "string" && args.idempotencyKey.trim()
        ? { idempotencyKey: args.idempotencyKey.trim() }
        : {}),
      triggerKind: "trigger.manual",
      payload: { input, source: "api" },
    })
    const result = execution.result
    if (result.status !== "succeeded") {
      return {
        ok: false,
        error: {
          code: "run-failed",
          message: result.error?.message ?? "workflow run failed",
        },
      }
    }

    const outputSchema = execution.version.interface.outputSchema
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
      workflowId: execution.version.workflowId,
      workflowName: execution.version.name,
      runId: result.runId,
      output: result.output,
    }
  } catch (err) {
    if (err instanceof WorkflowAdmissionError) {
      if (err.code === "deployment-not-found") {
        return {
          ok: false,
          error: {
            code: "not-published",
            message: err.message,
          },
        }
      }
      return {
        ok: false,
        error: { code: err.code, message: err.message, detail: err.detail },
      }
    }
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: { code: "tool-execution-failed", message } }
  }
}
