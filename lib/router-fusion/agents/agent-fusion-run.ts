/**
 * A turn an agent, a Squad member or a workflow node chose to run as Router +
 * Fusion work (ADR-0188 B5, D3/D21; master plan D3).
 *
 * The chat surface has `chat/chat-fusion-turn.ts`: a fusion turn there belongs
 * to a conversation, holds that conversation's session lock and writes its
 * answer into the transcript. This module is the same shape of work for the
 * `agentsWorkflows` surface, where none of that applies:
 *
 *  - the caller already owns the conversation (a chat session, a Squad run, a
 *    workflow run), so the run is created **session-less**: it takes no session
 *    lock and writes no transcript. A Squad's team run keeps the one session
 *    lock and the members' runs are children of it (D21);
 *  - the answer is returned to the caller, which decides what to do with it —
 *    a teammate's reply, a node's `completion`, an agent's captured text;
 *  - the mode was chosen explicitly, so a route that fits nothing is a refusal
 *    the caller must show, never a quiet fall back to an ordinary call (D38).
 *
 * The gate in `gate/explicit-run.ts` is the only caller: it checks the
 * `agentsWorkflows` switch and loads this module through `load-engine.ts`, so
 * an account with the surface off evaluates none of it.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import {
  CONTRACT_SCHEMA_VERSION,
  microusdToUsd,
  usdToMicrousd,
  type ExecutionMode,
  type Message,
  type RunRequest,
} from "@cognia/router-fusion"
import { normalizeRouterFusionSettings } from "@cognia/router-fusion/settings/settings"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

import { liveSettingsReader } from "../calls/live-settings"
import { runTokenTotals } from "../api/chat-compat"
import { createRunApiRouteHost } from "../api/route-host"
import { EXECUTABLE_MODES, titleFor } from "../api/run-api"
import { tightestTenantLimit } from "../chat/tenant-budget"
import { windowLeaseOwner } from "../chat/chat-run-deps"
import { currentFusionStore } from "../chat/store-provider"
import { accountDatabaseAppliers } from "../db/outbox-appliers"
import { encodeRunInput } from "../db/run-input"
import { executeFusionRun } from "../runtime/orchestrator-host"
import { routeRunRequest } from "../routing/run-route"
import { webEvidenceAvailable } from "../tools/web-evidence"

/** Where the turn came from, for the run list and the governance catalog. */
export type AgentFusionOrigin = "agent" | "workflow"

export interface AgentFusionRunInput {
  /** The mode the caller chose. `auto` never reaches here — it is today's path. */
  mode: ExecutionMode
  origin: AgentFusionOrigin
  /** Stable id of the caller, e.g. `teammate:<id>` or `workflow:<stepId>`. */
  featureId: string
  /** The conversation the turn answers, oldest first, the new message last. */
  messages: readonly Message[]
  /** A structured answer the caller asked for; enables the schema verifier. */
  jsonSchema?: Record<string, unknown> | null
  /** The app project the turn belongs to; it may raise the data class (D30). */
  workspaceId?: string | null
  /** The directory the caller works in; a panel may read files there. */
  workspaceRoot?: string | null
  /**
   * INV-09: this turn already runs inside a fusion run. The router excludes
   * every non-direct action with `FUSION_RECURSION` rather than nesting one
   * orchestrated run inside another.
   */
  hasFusionAncestor: boolean
  appSettings: AppSettings
  signal?: AbortSignal
  /** Test seam: the deadline a run is created with. */
  deadlineMs?: number
}

export interface AgentFusionRunUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export type AgentFusionRunOutcome =
  | {
      kind: "answered"
      runId: string
      mode: ExecutionMode
      text: string
      /** `accepted`, or `degraded` when only part of the plan survived. */
      qualityStatus: "accepted" | "degraded" | "unknown"
      usage: AgentFusionRunUsage
      spentMicrousd: number
      modelCalls: number
      warnings: string[]
    }
  /** Nothing was spent, or the run ended without an answer. The caller shows the code. */
  | { kind: "refused"; code: string; reasons: string[]; runId?: string }

/** The largest deadline the contract accepts; a caller may only lower it. */
const MAX_DEADLINE_MS = 3_600_000
/** A prompt with no text at all still has to route as something. */
const EMPTY_PROMPT = "(no text)"

function refused(code: string, reasons: string[] = [], runId?: string): AgentFusionRunOutcome {
  return { kind: "refused", code, reasons, ...(runId ? { runId } : {}) }
}

/**
 * The request's user-visible prompt. The contract's `input_messages` are user
 * turns only and at most 20 of them, so the router sees the caller's own text;
 * the whole conversation (system turns included) is what the run executes on.
 */
function inputMessagesOf(messages: readonly Message[]): RunRequest["input_messages"] {
  const users = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter((content) => content.length > 0)
  const kept = users.slice(-20)
  if (kept.length === 0) return [{ role: "user", content: EMPTY_PROMPT }]
  return kept.map((content) => ({ role: "user" as const, content }))
}

/**
 * Run one `agentsWorkflows` turn as a Router + Fusion run and hand back its
 * answer. Throws only on an infrastructure fault; every refusal — PII, no
 * route, no budget, recursion — comes back as a value, because the caller has
 * to report it rather than crash a Squad run or a workflow step.
 */
export async function runAgentsWorkflowsFusion(
  input: AgentFusionRunInput
): Promise<AgentFusionRunOutcome> {
  const messages = [...input.messages]
  // The conversation leaves this device for models the router chose: it passes
  // the same gate a direct send does, before anything is stored or reserved.
  if (!hasNoLeakingPiiDeep(messages)) return refused("PII_BLOCKED", ["pii:prompt"])

  const settings = normalizeRouterFusionSettings(input.appSettings.routerFusion)
  const deadlineMs = Math.max(1_000, Math.min(input.deadlineMs ?? MAX_DEADLINE_MS, MAX_DEADLINE_MS))
  const request: RunRequest = {
    schema_version: CONTRACT_SCHEMA_VERSION,
    input_messages: inputMessagesOf(messages),
    // An explicit choice is never re-decided by a classifier (ROUTE-03).
    mode: input.mode,
    allowed_modes: [input.mode],
    profile: "balanced",
    budget: {
      max_cost_usd: microusdToUsd(usdToMicrousd(settings.runCapUsdByMode[input.mode])),
      mode: settings.budgetMode,
    },
    deadline_ms: deadlineMs,
    // A degraded panel answer is labelled; a caller that asked for a panel gets
    // the candidate that survived rather than nothing at all.
    allow_degraded: true,
    delivery: "verified_buffered",
  }

  const base = createRunApiRouteHost(input.appSettings)
  const host = {
    ...base,
    surface: "agentsWorkflows" as const,
    // INV-09 travels to the action router on the host, so the refusal is the
    // router's own `FUSION_RECURSION` rather than a rule restated here.
    hasFusionAncestor: input.hasFusionAncestor,
  }
  const runId = base.newId()
  const workspaceId = input.workspaceId ?? null
  const route = await routeRunRequest(host, {
    runId,
    decisionId: base.newId(),
    request,
    messages,
    jsonSchema: input.jsonSchema ?? null,
    // A session-less run still needs a stable id for the routing engine's own
    // per-conversation signals; the run id is that conversation.
    sessionId: runId,
    webToolsAvailable: webEvidenceAvailable(),
    executableModes: EXECUTABLE_MODES,
    workspaceId,
  })
  if (route.kind === "refused") return refused(route.code, [...route.reasons])

  const store = await currentFusionStore()
  const inputArtifact = await store.artifactStore(null).put(
    encodeRunInput({
      messages,
      allowDegraded: true,
      jsonSchema: input.jsonSchema ?? null,
    }),
    "application/json",
    `${input.origin}-input/${runId}`
  )
  const tenantRemaining = await tightestTenantLimit(
    input.appSettings.costBudget,
    Object.values(route.roles) as string[]
  )
  const created = await store.createRun({
    runId,
    inputArtifactId: inputArtifact.artifactId,
    // D21: the caller owns the conversation and its lock. A member run that
    // took the team session's lock would make the team look busy to itself.
    sessionId: null,
    surface: "agentsWorkflows",
    origin: input.origin,
    decision: route.decision,
    actionId: route.actionId,
    ruleId: route.ruleId,
    roleDeployments: { ...route.roles } as Record<string, string>,
    config: route.config,
    capMicrousd: route.capMicrousd,
    maxModelCalls: route.maxModelCalls,
    deadlineMs: route.deadlineMs,
    budgetMode: settings.budgetMode,
    tenantLimitRemainingMicrousd: tenantRemaining,
    title: titleFor(messages),
    task: route.task,
    acceptanceProfile: route.acceptanceProfile,
    dataClass: route.dataClass,
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    driver: "orchestrator",
  })
  if (!created.ok) return refused(created.code, [`create:${created.code}`])
  await store.db.fusionArtifacts.update(inputArtifact.artifactId, { runId })

  const outcome = await executeFusionRun(
    {
      store: async () => store,
      appliers: accountDatabaseAppliers,
      leaseOwner: windowLeaseOwner(),
      appSettings: liveSettingsReader(input.appSettings),
    },
    {
      runId,
      messages,
      ...(input.signal ? { signal: input.signal } : {}),
    }
  )
  switch (outcome.kind) {
    case "succeeded":
      break
    case "cancelled":
      return refused("RUN_CANCELLED", [], runId)
    case "busy":
      // Only this window creates these runs, under its own lease owner.
      return refused("RUN_BUSY", ["another worker holds this run"], runId)
    case "waiting":
      // A delegate run parked on a person (D21). Nothing is sealed and its
      // money stays held: an agent, a Squad member and a workflow step have no
      // one to ask mid-turn, so the turn ends here and the run waits in the
      // cockpit for the approval that resumes it.
      return refused(outcome.code, [outcome.message], runId)
    case "reconciling":
      // REC-06: a dispatched side effect with no receipt. Never re-run.
      return refused(outcome.code, [outcome.message], runId)
    default:
      return refused(outcome.code, [outcome.message], runId)
  }

  const run = await store.getRun(runId)
  const tokens = await runTokenTotals(store, runId)
  return {
    kind: "answered",
    runId,
    mode: outcome.result.mode_executed,
    text: outcome.result.answer,
    qualityStatus: outcome.result.quality_status,
    usage: {
      promptTokens: tokens.promptTokens,
      completionTokens: tokens.completionTokens,
      totalTokens: tokens.promptTokens + tokens.completionTokens,
    },
    spentMicrousd: run?.budget.spentMicrousd ?? 0,
    modelCalls: run?.budget.modelCalls ?? 0,
    warnings: [...outcome.result.warnings],
  }
}
