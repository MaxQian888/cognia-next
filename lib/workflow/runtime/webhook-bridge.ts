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
import { validateWorkflowCronExpression } from "@/lib/scheduler/cron-parser"
import {
  syncPluginTriggerInstances,
  unsyncPluginTriggerInstances,
} from "@/lib/workflow/triggers/lifecycle"
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

const SYNCED_TRIGGER_KINDS = new Set<WorkflowNode["type"]>([
  "trigger.manual",
  "trigger.cron",
  "trigger.connector.inbound",
  "trigger.chat.message",
  "trigger.goal.completed",
  "trigger.webhook",
  "trigger.github.webhook",
  "trigger.team",
  "trigger.desktop.event",
  "trigger.terminal.command",
  "trigger.pet.event",
  "trigger.workflow.completed",
])

const syncedTriggersByWorkflow = new Map<string, Map<string, WorkflowNode["type"]>>()

interface TriggerSyncOptions {
  signal?: AbortSignal
}

/**
 * Push every trigger node in `workflow` to Rust. Uses the node id as the
 * trigger id so the registry stays stable across saves.
 *
 * The module retains the last successful projection so removed, disabled, or
 * kind-changed nodes are unregistered before the current projection is
 * upserted. Rust restarts with the desktop process, so rebuilding this map on
 * renderer boot is sufficient; every active workflow is synced at startup.
 */
export async function syncWorkflowTriggers(
  workflow: VisualWorkflow,
  options: TriggerSyncOptions = {}
): Promise<void> {
  if (options.signal?.aborted) return
  const triggers =
    workflow.isTemplate || workflow.isBuiltIn
      ? []
      : workflow.nodes.filter((node) => !node.data.disabled && SYNCED_TRIGGER_KINDS.has(node.type))
  try {
    for (const node of triggers) validateTriggerForSync(node)
  } catch (error) {
    // Do not leave an older valid schedule active after the persisted node is
    // edited into an invalid state.
    await unsyncWorkflowTriggers(workflow)
    throw error
  }

  const previous = syncedTriggersByWorkflow.get(workflow.id) ?? new Map()
  const desired = new Map(triggers.map((node) => [node.id, node.type]))
  const staleIds = [...previous].flatMap(([triggerId, kind]) =>
    desired.get(triggerId) === kind ? [] : [triggerId]
  )
  await Promise.all(staleIds.map((triggerId) => unregisterTrigger(workflow.id, triggerId)))
  if (options.signal?.aborted) return

  // A workflow with an `io.webhook.respond` node wants the receiver to hold
  // the inbound request open for a dynamic reply. Computed once and threaded
  // into every webhook trigger so the opt-in is implicit (no extra config).
  const awaitResponse = workflow.nodes.some((n) => n.type === "io.webhook.respond")
  await Promise.all(triggers.map((node) => syncOneTrigger(workflow.id, node, awaitResponse)))
  syncedTriggersByWorkflow.set(workflow.id, desired)
  if (options.signal?.aborted) return
  await syncPluginTriggerInstances(workflow)
}

function validateTriggerForSync(node: WorkflowNode): void {
  if (node.type !== "trigger.cron") return
  const expression = ((node.data.params ?? {}) as CronParams).cron ?? ""
  const validation = validateWorkflowCronExpression(expression)
  if (!validation.valid) {
    throw new Error(
      "Cannot register workflow cron '" +
        expression +
        "': " +
        (validation.error ?? "invalid expression")
    )
  }
}

async function syncOneTrigger(
  workflowId: string,
  node: WorkflowNode,
  awaitResponse: boolean
): Promise<void> {
  const baseInput = {
    workflowId,
    triggerId: node.id,
    kind: node.type,
    enabled: true,
  }
  const params = (node.data.params ?? {}) as Record<string, unknown>
  switch (node.type) {
    case "trigger.cron": {
      const cronParams = params as CronParams
      const expression = cronParams.cron ?? ""
      await registerTrigger({
        ...baseInput,
        cron: expression,
        timezone: cronParams.timezone,
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
    case "trigger.workflow.completed":
    case "trigger.terminal.command":
    case "trigger.desktop.event":
    case "trigger.pet.event":
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
  const triggerIds = new Set(
    workflow.nodes.filter((node) => node.type.startsWith("trigger.")).map((node) => node.id)
  )
  for (const triggerId of syncedTriggersByWorkflow.get(workflow.id)?.keys() ?? []) {
    triggerIds.add(triggerId)
  }
  await Promise.all([...triggerIds].map((triggerId) => unregisterTrigger(workflow.id, triggerId)))
  syncedTriggersByWorkflow.delete(workflow.id)
  await unsyncPluginTriggerInstances(workflow)
}

/** Test-only reset for the renderer-local registration projection. */
export function _resetSyncedTriggerStateForTest(): void {
  syncedTriggersByWorkflow.clear()
}

/** Re-export so the inspector form can show the URL without a second hop. */
export { getWebhookUrl }
