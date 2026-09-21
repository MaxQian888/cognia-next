/**
 * The `ai.prompt` node's Router + Fusion action (ADR-0188 B5; master plan D3).
 *
 * An `ai.prompt` node makes one model call. A node whose `action` names a
 * fusion mode makes a fusion run instead: `cascade` escalates from a cheap
 * model only when its answer fails the check, `panel` runs a review board,
 * `direct` is one routed and ledgered call. `auto` — the default, and every
 * node authored before this field existed — is the executor's own path, which
 * on an enabled surface is already a ledgered ordinary call.
 *
 * The field is part of `params`, so it is inside the node's config hash the
 * same way every other authored field is (`workflowVersionDigest`,
 * `workflowEditorRevision` canonicalize `node.data`): changing the action
 * changes the workflow version, which is what makes a published version
 * honest about what it will spend.
 *
 * Validation runs three times over the same rule, because each layer catches
 * a different mistake:
 *   - the params schema rejects a value that is not an action at all;
 *   - the inspector disables what the account cannot run and says why;
 *   - this module refuses at execution time, because settings change between
 *     authoring and the 3 a.m. cron run that uses them.
 */

import type { StepExecutionContext, StepExecutionResult } from "@/types/workflow/visual"
import { guardWorkflowEgress } from "@/lib/workflow/runtime/egress-guard"
import {
  fusionActionChoiceOf,
  fusionActionRequested,
  runExplicitAgentFusionTurn,
  validateFusionActionChoice,
  type ExplicitFusionTurnInput,
  type FusionActionChoice,
} from "@/lib/router-fusion/gate/explicit-run"
import { RouterFusionRefusalError } from "@/lib/router-fusion/gate/faults"

import { nonRetryable } from "../shared/executor-support"
import { buildJsonInstruction, parseStructured } from "./structured"
import { validateAgainstJsonSchema } from "./schema-validate"

/** The `ai.prompt` params this module reads; the rest belong to the ordinary executor. */
export interface FusionActionParams {
  action?: FusionActionChoice
  systemPrompt?: string
  userPrompt?: string
  responseFormat?: "text" | "json"
  jsonSchema?: string
  outputSchema?: Record<string, unknown>
  onSchemaViolation?: "fail" | "soft"
  piiGate?: "off" | "block" | "redact"
}

/** What a fusion-run node writes into `output`, on top of the ordinary fields. */
export interface FusionNodeOutputTrace {
  runId: string
  mode: string
  qualityStatus: "accepted" | "degraded" | "unknown"
  modelCalls: number
  spentMicrousd: number
  warnings: string[]
}

/**
 * Why a stored choice cannot run at execution time. `surfaceOff` is not here:
 * a switched-off surface is not an error, it is the existing path (D37).
 */
const ISSUE_MESSAGE: Record<string, string> = {
  modeDormant: "this action is not available in this release",
  workspaceRequired: "the delegate action needs a workspace to work in",
}

export interface RunFusionActionDeps {
  /** The account settings the gate reads; read from this host when omitted. */
  settings?: ExplicitFusionTurnInput["settings"]
  /** Test seam. */
  loadHost?: ExplicitFusionTurnInput["loadHost"]
}

/**
 * Run the node as a fusion run, or answer `null` so the caller runs the
 * ordinary `ai.prompt` executor.
 *
 * Throws a non-retryable error when the node's own configuration cannot run:
 * an explicitly chosen action is a decision the author made about what this
 * step costs and checks, so quietly making one plain call instead would be the
 * wrong answer (D38). An infrastructure fault surfaces from the gate as
 * `RouterFusionUnavailableError`, which the runtime's error policy handles
 * like any other step failure.
 */
export async function runAiPromptFusionAction(
  ctx: StepExecutionContext,
  deps: RunFusionActionDeps = {}
): Promise<StepExecutionResult | null> {
  const params = ctx.params as FusionActionParams
  const action = fusionActionChoiceOf(params.action)
  if (!fusionActionRequested(action)) return null

  const settings =
    deps.settings ??
    (await (
      await import("@/lib/router-fusion/gate/current-settings")
    ).currentRouterFusionGateSettings())
  const workspaceId = ctx.projectId ?? null
  const issue = validateFusionActionChoice({
    action,
    settings,
    hasWorkspace: Boolean(workspaceId),
  })
  // Off is not a configuration error: D37 says a switched-off surface runs the
  // existing code, byte for byte. The inspector is where an author is told
  // their choice is currently inert; a 3 a.m. cron run just runs the node.
  if (issue === "surfaceOff") return null
  if (issue) {
    throw nonRetryable(`ai.prompt: action "${action}" cannot run — ${ISSUE_MESSAGE[issue]}`)
  }

  const jsonMode = params.responseFormat === "json"
  const outputSchema = params.outputSchema
  const enforceSchema = jsonMode && !!outputSchema && Object.keys(outputSchema).length > 0
  const schemaHint = enforceSchema ? JSON.stringify(outputSchema, null, 2) : params.jsonSchema
  const systemPrompt = jsonMode
    ? [params.systemPrompt, buildJsonInstruction(schemaHint)].filter(Boolean).join("\n\n")
    : params.systemPrompt
  // The node's own PII gate runs before the fusion run's, exactly as it runs
  // before an ordinary call: an authored `block` is the author's rule, and the
  // run's `hasNoLeakingPiiDeep` check is the platform's.
  const guarded = guardWorkflowEgress({
    ...(ctx.securityContext ? { securityContext: ctx.securityContext } : {}),
    sink: "model",
    ...(params.piiGate ? { requestedMode: params.piiGate } : {}),
    value: { systemPrompt, userPrompt: params.userPrompt ?? "" },
  })

  const outcome = await runExplicitAgentFusionTurn({
    mode: action,
    origin: "workflow",
    featureId: `workflow:${ctx.stepId}`,
    messages: [
      ...(guarded.value.systemPrompt?.trim()
        ? [{ role: "system" as const, content: guarded.value.systemPrompt }]
        : []),
      { role: "user" as const, content: guarded.value.userPrompt.trim() || "(no text)" },
    ],
    ...(enforceSchema ? { jsonSchema: outputSchema } : {}),
    workspaceId,
    // Every node of one workflow run shares the run's scope, so a node that
    // runs inside a fusion run is refused with FUSION_RECURSION (INV-09).
    scopeId: ctx.runId,
    settings,
    signal: ctx.signal,
    ...(deps.loadHost ? { loadHost: deps.loadHost } : {}),
  })
  // The surface went off between the check above and the dispatch.
  if (outcome.kind === "skipped") return null
  if (outcome.kind === "refused") {
    throw new RouterFusionRefusalError(
      outcome.code,
      `ai.prompt: Router + Fusion refused this ${action} step: ${outcome.code}`,
      {
        reasons: outcome.reasons,
        stepId: ctx.stepId,
        ...(outcome.runId ? { runId: outcome.runId } : {}),
      }
    )
  }

  const usage = {
    inputTokens: outcome.usage.promptTokens,
    outputTokens: outcome.usage.completionTokens,
    totalTokens: outcome.usage.totalTokens,
  }
  ctx.emitStream?.(outcome.text)
  ctx.reportUsage?.({ ...usage, costUsd: outcome.spentMicrousd / 1_000_000 })
  const trace: FusionNodeOutputTrace = {
    runId: outcome.runId,
    mode: outcome.mode,
    qualityStatus: outcome.qualityStatus,
    modelCalls: outcome.modelCalls,
    spentMicrousd: outcome.spentMicrousd,
    warnings: outcome.warnings,
  }
  const base = {
    completion: outcome.text,
    usage,
    stub: false,
    fusion: trace,
    ...(guarded.redacted ? { piiRedacted: true } : {}),
  }
  if (!jsonMode) return { output: base }
  const parsed = parseStructured(outcome.text)
  const schemaFields = enforceSchema
    ? parsed.error
      ? { schemaValid: false }
      : (() => {
          const validation = validateAgainstJsonSchema(outputSchema, parsed.value)
          return validation.ok
            ? { schemaValid: true }
            : { schemaValid: false, schemaErrors: validation.errors }
        })()
    : {}
  return {
    output: {
      ...base,
      structured: parsed.value,
      ...(parsed.error ? { parseError: parsed.error } : {}),
      ...schemaFields,
    },
  }
}
