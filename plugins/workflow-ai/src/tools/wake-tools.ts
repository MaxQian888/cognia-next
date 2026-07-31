/**
 * Workflow-AI plugin — `wf_emit_workflow_event`: wake a `flow.wait` node that
 * is blocked in event mode (W3.2 of the workflow-linkage remediation).
 *
 * The wait node subscribes to the in-process wake bus under either its
 * user-declared `eventKey` or the run-scoped default `${runId}:${stepId}`;
 * this tool fires that key. It is the agent-reachable wake source — a user
 * can tell the assistant "the deploy is approved, resume the release
 * workflow" and the waiting run continues with the supplied payload as the
 * wait node's `data` output.
 *
 * Firing a key nobody is waiting on is NOT an error (`delivered: false`) —
 * events that arrive before the subscription are dropped by design; the
 * caller can retry once the workflow reaches its wait step.
 */

import type { PluginTool } from "@/types/plugin"
import { emitWake } from "@/lib/workflow/runtime/wake-bus"
import { formatToolError } from "../store-bridge"

const PLUGIN_ID = "cognia-workflow-ai"

export function buildWakeTools(): PluginTool[] {
  return [
    {
      name: "wf_emit_workflow_event",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_emit_workflow_event",
        description:
          "Wake a workflow that is paused on a flow.wait node in event mode. Pass the node's declared event key (or `runId:stepId` for a run-scoped wait). Optional `data` is delivered to the waiting node as its output. Returns delivered:false when nothing is currently waiting on the key — the event is dropped, not queued.",
        category: "workflow",
        requiresApproval: true,
        parametersSchema: {
          type: "object",
          required: ["eventKey"],
          properties: {
            eventKey: {
              type: "string",
              description:
                "Wake key the flow.wait node subscribed under (its eventKey param, or `runId:stepId`).",
            },
            data: {
              type: "object",
              description: "Optional payload surfaced as the wait node's `data` output.",
              additionalProperties: true,
            },
          },
        },
      },
      execute: async (args) => {
        try {
          const eventKey = String(args.eventKey ?? "").trim()
          if (eventKey.length === 0) {
            return {
              ok: false,
              error: { code: "invalid-event-key", message: "eventKey is required" },
            }
          }
          const delivered = emitWake(eventKey, {
            source: "wf_emit_workflow_event",
            ...(args.data !== undefined ? { data: args.data } : {}),
          })
          return { ok: true, eventKey, delivered }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
  ]
}
