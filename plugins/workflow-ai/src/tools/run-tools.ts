/**
 * Workflow-AI plugin — run control tools (Phase C, L4 tier).
 *
 *   • wf_run_workflow        execute the entire workflow now
 *   • wf_run_from_step       execute starting from a specific step id
 *   • wf_cancel_run          abort a run in progress (by run id)
 *
 * Approval: REQUIRED (`requiresApproval: true`). These trigger real
 * side-effects — LLM calls cost tokens, connectors send messages, GitHub
 * actions touch repos. The ToolApprovalDialog (already in main chat
 * UI) gates every call; the structured payload (Phase E) lets the
 * dialog show "Workflow X · entry step Y".
 *
 * Quiet-hours note: `lib/connectors/outbound-runner.isInQuietHours` is
 * a per-connector check; there is no app-wide / per-workflow quiet
 * hours configuration to gate this surface against. When
 * `WorkflowSettings.quietHours` lands, wire it here and short-circuit
 * with a structured `{ ok: false, error: { code: "quiet-hours" } }`
 * instead of starting the run.
 */

import type { PluginTool } from "@cognia/plugin-sdk"
import { runWorkflow as runOrchestrator } from "@cognia/plugin-sdk/api/workflow-run"
import type { TriggerEvent } from "@cognia/plugin-sdk"
import { formatToolError, resolveStore } from "../store-bridge"

const PLUGIN_ID = "cognia-workflow-ai"

const WORKFLOW_ID_SCHEMA = {
  type: "string",
  description:
    "Workflow id to target. Omit if exactly one editor is open and you want to act on it.",
} as const

// Live AbortControllers keyed by run id so wf_cancel_run can interrupt
// the run started by wf_run_workflow / wf_run_from_step. The controller
// is removed once the run resolves regardless of outcome.
const ACTIVE_RUNS = new Map<string, AbortController>()

/**
 * Mint a run id in the orchestrator's own `run_<12 chars>` shape so the tool
 * can register its AbortController before the run starts. Passed through as
 * `RunWorkflowInput.runId`, which the orchestrator accepts as an override.
 */
function newRunId(): string {
  const raw =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().replace(/-/g, "")
      : Math.random().toString(36).slice(2).padEnd(12, "0")
  return `run_${raw.slice(0, 12)}`
}

function pickTrigger(workflowId: string, payload?: unknown): TriggerEvent {
  return {
    workflowId,
    kind: "trigger.manual",
    payload: (payload as Record<string, unknown>) ?? {},
    originAt: Date.now(),
  }
}

export function buildRunTools(): PluginTool[] {
  return [
    {
      name: "wf_run_workflow",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_run_workflow",
        description:
          "Execute the entire workflow from its manual trigger right now. Requires user approval. Returns the runId, final status (succeeded / failed / cancelled), and final error (if failed). Validation errors short-circuit before any node runs. Pass an optional payload to populate $trigger.payload for the run. ALWAYS fill `workflowName` and `entrySummary` so the approval dialog can show the user what they are about to run.",
        category: "workflow",
        requiresApproval: true,
        parametersSchema: {
          type: "object",
          properties: {
            workflowId: WORKFLOW_ID_SCHEMA,
            // (Phase E) Display hints — surfaced verbatim in the
            // ToolApprovalDialog so the user sees a structured "what's
            // about to happen" preview instead of bare json.
            workflowName: {
              type: "string",
              description: "Display name of the workflow (for the approval dialog).",
            },
            entrySummary: {
              type: "string",
              description:
                "One-line plain-English summary of what the run will do (for the approval dialog).",
            },
            payload: {
              type: "object",
              description: "Trigger payload — surfaced to nodes as `$trigger.payload`.",
              additionalProperties: true,
            },
          },
        },
      },
      execute: async (args, context) => {
        try {
          const { workflowId, store } = resolveStore({
            workflowId: args.workflowId as string | undefined,
          })
          const wf = store.getState().toWorkflow()
          const trigger = pickTrigger(workflowId, args.payload)
          const ac = new AbortController()
          // Honour the host-supplied AbortSignal so an upstream cancel
          // propagates to the orchestrator (PluginToolContext.signal).
          context.signal?.addEventListener("abort", () => ac.abort(), { once: true })
          // Mint the run id UP FRONT and hand it to the orchestrator
          // (`RunWorkflowInput.runId` is an accepted override) so the
          // controller can be registered BEFORE the await. Registering it
          // afterwards — which is what this did — meant `ACTIVE_RUNS` was
          // always empty by the time anyone could look, so `wf_cancel_run`
          // could never cancel anything and always answered
          // `wasActive: false` after prompting the user for approval.
          const runId = newRunId()
          ACTIVE_RUNS.set(runId, ac)
          try {
            const result = await runOrchestrator({
              workflow: wf,
              trigger,
              signal: ac.signal,
              runId,
            })
            return {
              ok: true,
              workflowId,
              runId: result.runId,
              status: result.status,
              output: result.output,
              error: result.error,
            }
          } finally {
            ACTIVE_RUNS.delete(runId)
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_run_from_step",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_run_from_step",
        description:
          "Execute the workflow starting from a specific step id. Every node strictly upstream of `stepId` is marked skipped. Useful for re-running just a failing branch. Requires user approval.",
        category: "workflow",
        requiresApproval: true,
        parametersSchema: {
          type: "object",
          required: ["stepId"],
          properties: {
            workflowId: WORKFLOW_ID_SCHEMA,
            stepId: { type: "string", description: "Node id to start from." },
            payload: { type: "object", additionalProperties: true },
          },
        },
      },
      execute: async (args, context) => {
        try {
          const { workflowId, store } = resolveStore({
            workflowId: args.workflowId as string | undefined,
          })
          const wf = store.getState().toWorkflow()
          const stepId = String(args.stepId)
          if (!wf.nodes.some((n) => n.id === stepId)) {
            return { ok: false, error: { code: "node-not-found", message: `No node "${stepId}".` } }
          }
          const trigger = pickTrigger(workflowId, args.payload)
          const ac = new AbortController()
          context.signal?.addEventListener("abort", () => ac.abort(), { once: true })
          const result = await runOrchestrator({
            workflow: wf,
            trigger,
            startStepId: stepId,
            signal: ac.signal,
          })
          ACTIVE_RUNS.set(result.runId, ac)
          ACTIVE_RUNS.delete(result.runId)
          return {
            ok: true,
            workflowId,
            runId: result.runId,
            status: result.status,
            startedFrom: stepId,
            output: result.output,
            error: result.error,
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_cancel_run",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_cancel_run",
        description:
          "Abort an in-flight run by its runId. Returns ok:true even if no matching run exists (so the agent can call defensively without checking first).",
        category: "workflow",
        requiresApproval: true,
        parametersSchema: {
          type: "object",
          required: ["runId"],
          properties: { runId: { type: "string" } },
        },
      },
      execute: async (args) => {
        try {
          const runId = String(args.runId)
          const ac = ACTIVE_RUNS.get(runId)
          if (!ac) return { ok: true, runId, wasActive: false }
          ac.abort()
          ACTIVE_RUNS.delete(runId)
          return { ok: true, runId, wasActive: true }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
  ]
}

/** Test helper — wipe the live run controllers between cases. */
export function __resetActiveRunsForTesting(): void {
  ACTIVE_RUNS.clear()
}
