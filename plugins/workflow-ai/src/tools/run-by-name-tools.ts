/**
 * Workflow-AI plugin — by-name run tools for IM-triggered execution.
 *
 *   • wf_list_workflows         enumerate workflows the user can target by name
 *   • wf_run_workflow_by_name   look up by name + emit an A2UI Approve surface
 *
 * These live next to `run-tools.ts` (which targets the open editor) because
 * they share the same plugin registration path; the *executors* take a
 * different code path:
 *
 *   - `wf_run_workflow` reads the editor store (`resolveStore`) and calls
 *     the orchestrator directly with `requiresApproval: true` — the
 *     desktop SDK pops a permission modal.
 *
 *   - `wf_run_workflow_by_name` runs from an IM chat session (no editor
 *     open). The desktop permission modal is invisible to the IM user.
 *     Instead the tool emits an A2UI Approve / Cancel surface back to the
 *     model; the bus dispatcher (`lib/connectors/bus.ts:dispatchConnectorCallback`)
 *     short-circuits the `wf_approve` callback kind and calls
 *     `startWorkflowFromIM` without a model re-prompt. `requiresApproval`
 *     is therefore `false` on this tool — the in-chat A2UI buttons are
 *     the approval gate.
 *
 * The model is instructed (via tool description) to attach the returned
 * `surface` to its reply. The plugin-tools sidecar bridge forwards
 * structured tool results to the assistant turn; the assistant then
 * decides whether to render the surface — which it should for any
 * successful resolution.
 */

import type { PluginTool } from "@/types/plugin"
import { getDb } from "@/lib/db/schema"
import {
  findWorkflowByName,
  listWorkflowSummaries,
  type WorkflowSummary,
} from "@/lib/workflow/library/lookup"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { buildApprovalSurface } from "@/lib/connectors/a2ui-bridge/workflow-to-a2ui"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"
import { formatToolError } from "../store-bridge"
import type { A2UISegmentContent } from "@/types/connectors/segment"

const PLUGIN_ID = "cognia-workflow-ai"

function newBindingId(): string {
  return "wfb_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 10)
}

/**
 * Read the chat session's IM platform binding so we know which adapter +
 * conversation to fan progress out to. Returns null when the session has
 * no IM binding (e.g., a desktop-only chat) — the caller surfaces a
 * structured error and the tool result tells the model to ask the user
 * to run the workflow from the editor instead.
 */
async function resolveTriggeredFrom(
  sessionId: string | undefined
): Promise<WorkflowTriggeredFrom | null> {
  if (!sessionId) return null
  const session = await getDb().sessions.get(sessionId)
  if (!session) return null
  const binding = session.platformBinding
  if (!binding) return null
  return {
    source: "im",
    adapterId: binding.adapterId,
    conversationKey: binding.conversationKey,
    sessionId,
    ...(await resolveTurnInitiator(binding.conversationKey)),
  }
}

/**
 * Identify the human whose message is driving the CURRENT turn: this tool
 * executes mid-turn, so the conversation's `running` inbound job carries the
 * verified sender (plus the resolved principal/account stamp when the
 * registry is on). The initiator feeds both the workflow run's initiator
 * field and the approval binding's actorScope — the callback authorization
 * guard only lets this user (or a configured operator) tap Approve.
 */
async function resolveTurnInitiator(
  conversationKey: string
): Promise<Pick<WorkflowTriggeredFrom, "initiator">> {
  const jobs = await getDb()
    .connectorInboundJobs.where("conversationKey")
    .equals(conversationKey)
    .filter((row) => row.status === "running")
    .toArray()
  const current = jobs.sort((a, b) => b.receivedAt - a.receivedAt)[0]
  if (!current) return {}
  const sender = current.event.sender
  return {
    initiator: {
      platformIdentityId: sender.id,
      remoteUserId: sender.remoteUserId,
      displayName: sender.displayName,
      ...(current.principalId && current.accountId
        ? { principalId: current.principalId, accountId: current.accountId }
        : {}),
    },
  }
}

/** Actor scope for approval bindings: the turn initiator, else operators. */
function approvalActorScope(
  triggeredFrom: WorkflowTriggeredFrom
): import("@/types/connectors/interaction").CallbackActorScope {
  const initiatorId = triggeredFrom.initiator?.remoteUserId
  return initiatorId ? { mode: "initiator", allowedUserIds: [initiatorId] } : { mode: "operators" }
}

function summariesToBullets(candidates: WorkflowSummary[]): string {
  return candidates
    .map((c, i) => `${i + 1}. ${c.name}${c.description ? ` — ${c.description}` : ""}`)
    .join("\n")
}

export function buildRunByNameTools(): PluginTool[] {
  return [
    {
      name: "wf_list_workflows",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_list_workflows",
        description:
          "List up to 50 workflows from the library by id + name + description. Use to disambiguate when a name the user provided is unclear, or to discover what's runnable in this workspace. Read-only.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              description: "Maximum number of summaries to return (default 50, max 200).",
              minimum: 1,
              maximum: 200,
            },
          },
        },
      },
      execute: async (args) => {
        try {
          const limit = clampInt(args.limit, 50, 1, 200)
          const summaries = await listWorkflowSummaries(limit)
          return { ok: true, count: summaries.length, workflows: summaries }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_run_workflow_by_name",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_run_workflow_by_name",
        description:
          "Resolve a workflow by display name and prepare it for execution from an IM chat. Returns an A2UI Approve/Cancel surface descriptor the agent MUST attach to its reply — the user's tap on Approve starts the actual run. When the name is ambiguous or unknown, returns a structured error with candidate names so the agent can re-prompt. Does NOT start the workflow itself; the in-chat A2UI gate is the approval step.",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          required: ["name"],
          properties: {
            name: {
              type: "string",
              description: "Display name of the workflow to run. Case-insensitive.",
            },
            runParams: {
              type: "object",
              description:
                "Optional payload — surfaced to trigger-aware nodes as $trigger.payload.",
              additionalProperties: true,
            },
          },
        },
      },
      execute: async (args, context) => {
        try {
          const name = String(args.name ?? "").trim()
          if (name.length === 0) {
            return { ok: false, error: { code: "invalid-name", message: "name is required" } }
          }

          const triggeredFrom = await resolveTriggeredFrom(context.sessionId)
          if (!triggeredFrom) {
            return {
              ok: false,
              error: {
                code: "not-an-im-session",
                message:
                  "This session has no IM platform binding. Use wf_run_workflow from the workflow editor instead.",
              },
            }
          }

          const lookup = await findWorkflowByName(name)
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

          // Type narrowing: `lookup.ok === true` past this point.
          if (!lookup.ok) throw new Error("unreachable")
          const { workflowId, name: resolvedName } = lookup

          const summary = await readWorkflowSummary(workflowId)
          const bindingId = newBindingId()
          const approveActionId = "wfapp:" + bindingId
          const cancelActionId = "wfcan:" + bindingId
          const surfaceId = "wfsurf:" + bindingId

          const payload = {
            workflowId,
            workflowName: resolvedName,
            runParams: (args.runParams as Record<string, unknown>) ?? {},
            triggeredFrom,
          }

          const actorScope = approvalActorScope(triggeredFrom)
          await Promise.all([
            recordCallbackBinding({
              adapterId: triggeredFrom.adapterId!,
              actionId: approveActionId,
              kind: "wf_approve",
              surfaceId,
              componentId: "approve",
              conversationKey: triggeredFrom.conversationKey,
              payload,
              actorScope,
              allowedActions: ["approve", "cancel"],
            }),
            recordCallbackBinding({
              adapterId: triggeredFrom.adapterId!,
              actionId: cancelActionId,
              kind: "wf_cancel",
              surfaceId,
              componentId: "cancel",
              conversationKey: triggeredFrom.conversationKey,
              payload,
              actorScope,
              allowedActions: ["approve", "cancel"],
            }),
          ])

          const surface = buildApprovalSurface({
            bindingId,
            workflowName: resolvedName,
            summary,
          })

          return {
            ok: true,
            workflowId,
            workflowName: resolvedName,
            surfaceId,
            // The agent attaches `surface` to its reply via the standard
            // A2UI surface emission path (the sidecar bridge wraps it).
            surface,
            instruction:
              "Attach the returned `surface` to your reply so the user sees the Approve/Cancel card. Do not start the workflow yourself — the user must tap Approve.",
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
    {
      name: "wf_subscribe_workflow_fanout",
      pluginId: PLUGIN_ID,
      definition: {
        name: "wf_subscribe_workflow_fanout",
        description:
          "Subscribe the CURRENT IM session to receive workflow run progress for a given workflow (by name). Every future run of that workflow will mirror its step events + terminal status into this conversation. Returns an A2UI Approve/Cancel surface the agent MUST attach to its reply — the actual subscription row is written only after the user taps Approve. Permissioning: the target conversation is hard-bound to this session — the tool cannot subscribe other channels (operator must use the Settings UI for cross-channel mirroring).",
        category: "workflow",
        requiresApproval: false,
        parametersSchema: {
          type: "object",
          required: ["name"],
          properties: {
            name: {
              type: "string",
              description: "Workflow display name to subscribe to. Case-insensitive.",
            },
          },
        },
      },
      execute: async (args, context) => {
        try {
          const name = String(args.name ?? "").trim()
          if (name.length === 0) {
            return { ok: false, error: { code: "invalid-name", message: "name is required" } }
          }
          const triggeredFrom = await resolveTriggeredFrom(context.sessionId)
          if (!triggeredFrom) {
            return {
              ok: false,
              error: {
                code: "not-an-im-session",
                message:
                  "This session has no IM platform binding. Subscriptions are scoped to IM channels — open Settings → Workflow → Fan-out to add a mirror from desktop.",
              },
            }
          }

          const lookup = await findWorkflowByName(name)
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
          const { workflowId, name: resolvedName } = lookup

          const bindingId = newBindingId()
          const approveActionId = "wffanoutapp:" + bindingId
          const cancelActionId = "wffanoutcan:" + bindingId
          const surfaceId = "wffanout:" + bindingId

          // Permission gate: target conversation is the CURRENT session's
          // platformBinding. The Claude tool cannot subscribe cross-channel
          // — cross-channel mirroring goes through the Settings UI.
          const payload = {
            workflowId,
            workflowName: resolvedName,
            target: {
              adapterId: triggeredFrom.adapterId!,
              conversationKey: triggeredFrom.conversationKey!,
            },
            createdBy: "claude-tool",
          }

          const actorScope = approvalActorScope(triggeredFrom)
          await Promise.all([
            recordCallbackBinding({
              adapterId: triggeredFrom.adapterId!,
              actionId: approveActionId,
              kind: "wf_fanout_approve",
              surfaceId,
              componentId: "approve",
              conversationKey: triggeredFrom.conversationKey,
              payload,
              actorScope,
              allowedActions: ["approve", "cancel"],
            }),
            recordCallbackBinding({
              adapterId: triggeredFrom.adapterId!,
              actionId: cancelActionId,
              kind: "wf_fanout_cancel",
              surfaceId,
              componentId: "cancel",
              conversationKey: triggeredFrom.conversationKey,
              payload,
              actorScope,
              allowedActions: ["approve", "cancel"],
            }),
          ])

          const surface = buildFanoutApprovalSurface({
            workflowName: resolvedName,
            approveActionId,
            cancelActionId,
          })

          return {
            ok: true,
            workflowId,
            workflowName: resolvedName,
            surfaceId,
            surface,
            instruction:
              "Attach the returned `surface` to your reply so the user sees the Approve/Cancel card. Do not write the subscription yourself — the user must tap Approve.",
          }
        } catch (err) {
          return formatToolError(err)
        }
      },
    },
  ]
}

/**
 * Build the fan-out Approve/Cancel card. Mirrors `buildApprovalSurface`
 * shape so the existing per-adapter mappers (Lark interactive_message,
 * WeCom template_card, wechat-personal numeric mirror) render it
 * identically — just with different copy.
 */
function buildFanoutApprovalSurface(input: {
  workflowName: string
  approveActionId: string
  cancelActionId: string
}): A2UISegmentContent {
  const title = `订阅「${input.workflowName}」`
  const summary = "把这个 workflow 的运行进度同步到当前会话。"
  const components: Record<string, unknown> = {
    root: {
      component: "Card",
      title,
      children: ["summary", "actions"],
    },
    summary: { component: "Text", text: summary },
    actions: { component: "Row", children: ["approve", "cancel"] },
    approve: {
      component: "Button",
      text: "Approve",
      action: "approve",
      value: input.approveActionId,
    },
    cancel: {
      component: "Button",
      text: "Cancel",
      action: "cancel",
      value: input.cancelActionId,
    },
  }
  const mirrorLines = [`# ${title}`, summary, "[Approve] [Cancel]", "回复 1 同意 / 2 取消"]
  return {
    components,
    dataModel: {},
    rootId: "root",
    surfaceType: "inline",
    title,
    widget: { fallbackText: mirrorLines.join("\n") },
  }
}

async function readWorkflowSummary(workflowId: string): Promise<string | undefined> {
  const row = await getDb().workflows.get(workflowId)
  if (!row) return undefined
  const desc = row.description?.trim()
  return desc && desc.length > 0 ? desc : undefined
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback
  const rounded = Math.floor(raw)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}
