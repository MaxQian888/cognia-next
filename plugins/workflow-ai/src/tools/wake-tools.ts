/**
 * Workflow-AI plugin — `wf_emit_workflow_event`: wake a `flow.wait` node that
 * is blocked in event mode (W3.2 of the workflow-linkage remediation).
 *
 * The wait node registers a durable event key; this tool persists an event
 * before attempting a match. It is the agent-reachable wake source — a user
 * can tell the assistant "the deploy is approved, resume the release
 * workflow" and the waiting run continues with the supplied payload as the
 * wait node's `data` output.
 *
 * Firing a key nobody is waiting on is not an error: the event remains
 * available for 24 hours and can resolve a later matching waitpoint once.
 */

import type { PluginTool } from "@cognia/plugin-sdk"
import { formatToolError, getWorkflowApi } from "../store-bridge"

const PLUGIN_ID = "cognia-workflow-ai"

export function buildWakeTools(): PluginTool[] {
  return [
    {
      name: "wf_emit_workflow_event",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_emit_workflow_event",
        description:
          "Emit a durable event for a flow.wait node. Pass the node's declared event key (or `runId:stepId` for a run-scoped wait). Optional data is delivered once; unmatched events are retained for 24 hours.",
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
            correlationId: {
              type: "string",
              description: "Optional correlation id used to target one matching run.",
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
          const event = await getWorkflowApi().emitWaitEvent({
            key: eventKey,
            ...(typeof args.correlationId === "string" && args.correlationId.trim()
              ? { correlationId: args.correlationId.trim() }
              : {}),
            source: "wf_emit_workflow_event",
            ...(args.data !== undefined ? { data: args.data } : {}),
          })
          return {
            ok: true,
            eventKey,
            delivered: Boolean(event.consumedByWaitpointId),
            queued: !event.consumedByWaitpointId,
            eventId: event.id,
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
  ]
}
