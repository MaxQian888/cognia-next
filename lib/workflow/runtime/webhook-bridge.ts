/**
 * Webhook trigger bridge — extracts the `trigger.webhook` and `trigger.cron`
 * nodes from a workflow snapshot and registers / unregisters them with the
 * Rust side via `registerTrigger` / `unregisterTrigger`.
 *
 * Called from the canvas save path so the local webhook router knows about
 * every workflow as soon as the user saves. In web mode the underlying
 * `safeInvoke` calls all no-op gracefully.
 */

import type { VisualWorkflow, WorkflowNode } from "@/types/workflow/visual"
import { registerTrigger, unregisterTrigger, getWebhookUrl } from "./tauri-bridge"

interface WebhookParams {
  path?: string
  method?: string
  hmacSecret?: string
  responseStatus?: number
  responseTemplate?: string
  responseTimeoutMs?: number
}

interface CronParams {
  cron?: string
  timezone?: string
}

/**
 * Push every trigger node in `workflow` to Rust. Uses the node id as the
 * trigger id so the registry stays stable across saves.
 *
 * This intentionally registers each trigger eagerly — the alternative
 * (compute the diff vs prior state) adds complexity for little gain since
 * the Rust handlers are idempotent (cron upserts, webhook upserts by path).
 */
export async function syncWorkflowTriggers(workflow: VisualWorkflow): Promise<void> {
  const triggers = workflow.nodes.filter((n) => n.type.startsWith("trigger."))
  // A workflow with an `io.webhook.respond` node wants the receiver to hold
  // the inbound request open for a dynamic reply. Computed once and threaded
  // into every webhook trigger so the opt-in is implicit (no extra config).
  const awaitResponse = workflow.nodes.some((n) => n.type === "io.webhook.respond")
  await Promise.all(triggers.map((node) => syncOneTrigger(workflow.id, node, awaitResponse)))
}

async function syncOneTrigger(
  workflowId: string,
  node: WorkflowNode,
  awaitResponse: boolean
): Promise<void> {
  const enabled = !node.data.disabled
  const baseInput = {
    workflowId,
    triggerId: node.id,
    kind: node.type,
    enabled,
  }
  const params = (node.data.params ?? {}) as Record<string, unknown>
  switch (node.type) {
    case "trigger.cron": {
      const cronParams = params as CronParams
      await registerTrigger({
        ...baseInput,
        cron: cronParams.cron,
      })
      return
    }
    case "trigger.webhook":
    case "trigger.github.webhook": {
      const webhookParams = params as WebhookParams
      await registerTrigger({
        ...baseInput,
        webhookPath: webhookParams.path,
        webhookMethod: webhookParams.method,
        webhookHmacSecret: webhookParams.hmacSecret,
        webhookResponseStatus: webhookParams.responseStatus,
        webhookResponseBody: webhookParams.responseTemplate,
        webhookAwaitResponse: awaitResponse,
        webhookResponseTimeoutMs:
          typeof webhookParams.responseTimeoutMs === "number"
            ? webhookParams.responseTimeoutMs
            : undefined,
        signatureMode: node.type === "trigger.github.webhook" ? "github" : undefined,
      })
      return
    }
    case "trigger.connector.inbound":
    case "trigger.chat.message":
    case "trigger.goal.completed":
    case "trigger.terminal.command":
    case "trigger.desktop.event":
    case "trigger.team":
    case "trigger.manual":
      // No Rust state for these — they ride existing TS hooks or synthesized runs.
      await registerTrigger(baseInput)
      return
    default:
      return
  }
}

/**
 * Unregister every trigger node in `workflow`. Called when a workflow is
 * deleted; idempotent for nodes not previously registered.
 */
export async function unsyncWorkflowTriggers(workflow: VisualWorkflow): Promise<void> {
  const triggers = workflow.nodes.filter((n) => n.type.startsWith("trigger."))
  await Promise.all(triggers.map((node) => unregisterTrigger(node.id)))
}

/** Re-export so the inspector form can show the URL without a second hop. */
export { getWebhookUrl }
