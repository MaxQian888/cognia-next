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
 *    the caller must show, never a quiet fall back to an ordinary call (D38);
 *  - a delegate run that parks on a person (a write outside its allowed paths,
 *    or applying its patch into the workspace) is WAITED ON, not failed. The
 *    run is not projected as a cockpit row of its own — the workflow run or
 *    Squad run that owns the step already is one — so the approval is raised
 *    as a `fusion_approval` interrupt on that caller's execution run
 *    (`parentExecutionRunId`). The cockpit's approve / deny reach
 *    `gate/run-control.ts` through the ordinary control plane, the run is
 *    resumed, and this caller drives it on to its answer.
 *
 * The gate in `gate/explicit-run.ts` is the only caller: it checks the
 * `agentsWorkflows` switch and loads this module through `load-engine.ts`, so
 * an account with the surface off evaluates none of it.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import {
  CONTRACT_SCHEMA_VERSION,
  isTerminalRunStatus,
  microusdToUsd,
  usdToMicrousd,
  type DelegatePendingApproval,
  type ExecutionMode,
  type Message,
  type RoleCallExecutor,
  type RunRequest,
  type RunResult,
} from "@cognia/router-fusion"
import { normalizeRouterFusionSettings } from "@cognia/router-fusion/settings/settings"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

import { liveSettingsReader } from "../calls/live-settings"
import { runTokenTotals } from "../api/chat-compat"
import { createRunApiRouteHost } from "../api/route-host"
import { EXECUTABLE_MODES, readRunResult, titleFor } from "../api/run-api"
import { tightestTenantLimit } from "../chat/tenant-budget"
import { windowLeaseOwner } from "../chat/chat-run-deps"
import { currentFusionStore } from "../chat/store-provider"
import type { ChatRouteHost } from "../chat/route-chat-turn"
import type { FusionLedgerStore } from "../db/ledger-store"
import { drainFusionOutbox, type OutboxAppliers } from "../db/outbox"
import { accountDatabaseAppliers } from "../db/outbox-appliers"
import { encodeRunInput } from "../db/run-input"
import type { FusionRunRow } from "../db/types"
import type { DelegateHostPorts } from "../runtime/delegate-host-ports"
import {
  executeFusionRun,
  type FusionRunOutcome,
  type OrchestratorDeps,
} from "../runtime/orchestrator-host"
import { holdRunDriver } from "../runtime/run-driver"
import type { DelegateCapabilityDeps } from "../routing/delegate-capabilities"
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
  /**
   * The directory the caller works in; a panel may read files there. A
   * delegate route resolves its own checkout from {@link workspaceId} (the
   * project's primary root, where its acceptance profile was approved), so
   * this is the delegate's fallback only when the route found none.
   */
  workspaceRoot?: string | null
  /**
   * The execution run the caller's work belongs to — the workflow run of a
   * node, the team run of a Squad member. A delegate run that parks on a
   * person raises its `fusion_approval` interrupt HERE, because the fusion
   * run is how that step is carried out, not a second cockpit row. Without
   * one (or when it is already settled) a parked run has no one who can
   * answer it, so it is cancelled and reported as `APPROVAL_UNREACHABLE`.
   */
  parentExecutionRunId?: string | null
  /**
   * How a delegate run delivers its verified change (`FusionRunRow.delegateDelivery`).
   * `patch_only` — the default — hands back a patch; `workspace_updated`
   * writes it into the checkout after a person approves exactly that patch on
   * exactly that base. Ignored by every other mode.
   */
  delegateDelivery?: "patch_only" | "workspace_updated"
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

/**
 * Where a parked delegate run's decision is shown. Production raises it on
 * the caller's execution run through the control plane's own interrupt
 * writer; a test substitutes a recorder.
 */
export interface AgentFusionApprovalSurface {
  /**
   * Raise the approval on the caller's execution run. `false` when that run
   * cannot carry it — gone, or already settled — so nobody could answer it.
   * Raising the same approval twice is a no-op (the id is the digest's).
   */
  raise(input: {
    parentExecutionRunId: string
    fusionRunId: string
    approval: DelegatePendingApproval
    projectId: string | null
    expiresAt: number
  }): Promise<boolean>
  /** Take a still-pending approval down when the wait ended without a person. */
  withdraw(input: { parentExecutionRunId: string; approvalId: string }): Promise<void>
}

/** Test seams; production leaves every one of them unset. */
export interface AgentFusionRunDeps {
  store?: FusionLedgerStore
  routeHost?: ChatRouteHost
  delegateCapabilities?: DelegateCapabilityDeps
  executor?: RoleCallExecutor
  delegatePorts?: (store: FusionLedgerStore, run: FusionRunRow) => Promise<DelegateHostPorts>
  appliers?: OutboxAppliers
  leaseOwner?: string
  approvals?: AgentFusionApprovalSurface
  /** How often a parked run is looked at while a person decides. */
  approvalPollMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Orchestrator timing seams, forwarded as-is. */
  orchestrator?: Pick<OrchestratorDeps, "heartbeatMs" | "cancelPollMs" | "sleep" | "newId">
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
/** How often a parked run is re-read while a person decides. */
export const APPROVAL_POLL_MS = 1_000
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
  input: AgentFusionRunInput,
  deps: AgentFusionRunDeps = {}
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

  const base = deps.routeHost ?? createRunApiRouteHost(input.appSettings)
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
    ...(deps.delegateCapabilities ? { delegateCapabilities: deps.delegateCapabilities } : {}),
  })
  if (route.kind === "refused") return refused(route.code, [...route.reasons])
  // The checkout the run reads: for delegate, the project's own root the route
  // resolved (the acceptance profile was approved against it); the caller's
  // directory only when the route found none, and for every other mode.
  const workspaceRoot = route.workspaceRoot ?? input.workspaceRoot ?? null

  const store = deps.store ?? (await currentFusionStore())
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
    // What a delegate run needs to verify anything (WP-D4), exactly as the Run
    // API persists it (`api/run-api-host.ts`): the project its acceptance
    // profile and approval live on, the checkout it stages from, and the
    // profile id. A non-delegate route carries only the caller's directory.
    ...(route.projectId ? { projectId: route.projectId } : {}),
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(route.acceptanceProfileId ? { acceptanceProfileId: route.acceptanceProfileId } : {}),
    ...(route.mode === "delegate" && input.delegateDelivery
      ? { delegateDelivery: input.delegateDelivery }
      : {}),
    driver: "orchestrator",
  })
  if (!created.ok) return refused(created.code, [`create:${created.code}`])
  await store.db.fusionArtifacts.update(inputArtifact.artifactId, { runId })

  const appliers = deps.appliers ?? accountDatabaseAppliers
  const orchestratorDeps: OrchestratorDeps = {
    store: async () => store,
    appliers,
    leaseOwner: deps.leaseOwner ?? windowLeaseOwner(),
    appSettings: liveSettingsReader(input.appSettings),
    ...(deps.executor ? { executor: deps.executor } : {}),
    ...(deps.delegatePorts ? { delegatePorts: deps.delegatePorts } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...deps.orchestrator,
  }
  const execute = () =>
    executeFusionRun(orchestratorDeps, {
      runId,
      messages,
      ...(input.signal ? { signal: input.signal } : {}),
    })

  // This caller drives its own run from start to seal, across any number of
  // approvals: a decision from the cockpit resumes the run, and `driveRun`
  // (which the decision calls) must not start a second executor for it here.
  const releaseDriver = holdRunDriver(runId)
  let outcome: FusionRunOutcome
  try {
    outcome = await execute()
    while (outcome.kind === "waiting") {
      outcome = await waitForDecision({
        store,
        appliers,
        runId,
        approval: outcome.approval,
        parentExecutionRunId: input.parentExecutionRunId ?? null,
        projectId: route.projectId,
        execute,
        approvals: deps.approvals ?? callerApprovalSurface,
        pollMs: deps.approvalPollMs ?? APPROVAL_POLL_MS,
        sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
        now: deps.now ?? (() => Date.now()),
        ...(input.signal ? { signal: input.signal } : {}),
      })
    }
  } finally {
    releaseDriver()
  }
  let result: RunResult
  switch (outcome.kind) {
    case "succeeded":
      result = outcome.result
      break
    case "cancelled":
      return refused("RUN_CANCELLED", [], runId)
    case "busy":
      // Only this window creates these runs, under its own lease owner.
      return refused("RUN_BUSY", ["another worker holds this run"], runId)
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
    mode: result.mode_executed,
    text: result.answer,
    qualityStatus: result.quality_status,
    usage: {
      promptTokens: tokens.promptTokens,
      completionTokens: tokens.completionTokens,
      totalTokens: tokens.promptTokens + tokens.completionTokens,
    },
    spentMicrousd: run?.budget.spentMicrousd ?? 0,
    modelCalls: run?.budget.modelCalls ?? 0,
    warnings: [...result.warnings],
  }
}

type SettledOutcome = Exclude<FusionRunOutcome, { kind: "waiting" }>
type WaitOutcome = FusionRunOutcome

interface WaitForDecisionInput {
  store: FusionLedgerStore
  appliers: OutboxAppliers
  runId: string
  approval: DelegatePendingApproval
  parentExecutionRunId: string | null
  projectId: string | null
  execute: () => Promise<FusionRunOutcome>
  approvals: AgentFusionApprovalSurface
  pollMs: number
  sleep: (ms: number) => Promise<void>
  now: () => number
  signal?: AbortSignal
}

/**
 * Wait for a person to answer the approval a delegate run parked on, then
 * carry the run on (ADR-0188 B4, D21).
 *
 * The decision itself happens elsewhere — the cockpit answers the interrupt,
 * `gate/run-control.ts` records it against the digest and resumes the run —
 * so this only watches the ledger:
 *
 * - still waiting → keep waiting, until the approval's own expiry (the
 *   interrupt's `expiresAt`) or the caller's signal, either of which cancels
 *   the run so its held money is released and takes the question down;
 * - resumed (queued / running) → drive it here, from the journal: the steps
 *   that happened replay, the rest run. Another window that already took the
 *   lease is left to finish, and its seal is read back;
 * - sealed → the outcome the seal recorded.
 *
 * A parked run whose caller has no execution run to carry the question cannot
 * be answered by anyone, so it is cancelled at once as `APPROVAL_UNREACHABLE`
 * rather than left holding money until its deadline.
 */
async function waitForDecision(input: WaitForDecisionInput): Promise<WaitOutcome> {
  const parked = await input.store.getRun(input.runId)
  const expiresAt = parked?.deadlineAt ?? input.now()
  const raised = input.parentExecutionRunId
    ? await input.approvals
        .raise({
          parentExecutionRunId: input.parentExecutionRunId,
          fusionRunId: input.runId,
          approval: input.approval,
          projectId: input.projectId,
          expiresAt,
        })
        .catch(() => false)
    : false
  if (!raised) {
    await cancelParkedRun(input)
    return {
      kind: "failed",
      code: "APPROVAL_UNREACHABLE",
      message: input.parentExecutionRunId
        ? "the run this step belongs to can no longer ask for a decision"
        : "this caller has no run to ask for a decision on",
    }
  }
  const withdraw = () =>
    input.approvals
      .withdraw({
        parentExecutionRunId: input.parentExecutionRunId as string,
        approvalId: input.approval.approvalId,
      })
      .catch(() => undefined)

  for (;;) {
    if (input.signal?.aborted) {
      await cancelParkedRun(input)
      await withdraw()
      return { kind: "cancelled" }
    }
    const run = await input.store.getRun(input.runId)
    if (!run) return { kind: "failed", code: "RUN_NOT_FOUND", message: `no run ${input.runId}` }
    if (run.status === "waiting_for_approval" || run.status === "waiting_for_input") {
      if (input.now() >= expiresAt) {
        await cancelParkedRun(input)
        await withdraw()
        return {
          kind: "failed",
          code: "APPROVAL_EXPIRED",
          message: "nobody answered the approval before it expired",
        }
      }
      await input.sleep(input.pollMs)
      continue
    }
    if (isTerminalRunStatus(run.status)) return settledOutcomeOf(input.store, run)
    if (run.status === "reconciling") {
      return {
        kind: "reconciling",
        code: run.error?.code ?? "RECONCILIATION_REQUIRED",
        message: run.error?.message ?? "a side effect's outcome is unknown",
      }
    }
    // Resumed: queued or running. Drive it here unless another worker has it.
    const next = await input.execute()
    if (next.kind !== "busy") return next
    await input.sleep(input.pollMs)
  }
}

/** Cancel a parked run and apply what its seal queued (the run is not ours to finish). */
async function cancelParkedRun(input: {
  store: FusionLedgerStore
  appliers: OutboxAppliers
  runId: string
}): Promise<void> {
  await input.store.cancelRun(input.runId)
  await drainFusionOutbox(input.store.db, input.appliers, input.store.outboxContext()).catch(
    () => undefined
  )
}

/** The outcome of a run another worker sealed, read back from its record. */
async function settledOutcomeOf(
  store: FusionLedgerStore,
  run: FusionRunRow
): Promise<SettledOutcome> {
  switch (run.status) {
    case "succeeded": {
      const sealed = await readRunResult(store, run)
      if (sealed.result) return { kind: "succeeded", result: sealed.result }
      return {
        kind: "failed",
        code: sealed.expired ? "RESULT_EXPIRED" : "RESULT_MISSING",
        message: "the run succeeded but its result could not be read",
      }
    }
    case "cancelled":
      return { kind: "cancelled" }
    default:
      return {
        kind: "failed",
        code: run.error?.code ?? (run.status === "expired" ? "DEADLINE_EXCEEDED" : "RUN_FAILED"),
        message: run.error?.message ?? `the run ended ${run.status}`,
      }
  }
}

/**
 * Production: the approval rides on the caller's execution run, through the
 * control plane's own interrupt writer — so the cockpit, the attention list
 * and a paired device all see it the way they see every other decision.
 */
const callerApprovalSurface: AgentFusionApprovalSurface = {
  async raise(input) {
    const [{ getExecutionRun }, { createRunInterrupt }, { getDb }, { fusionApprovalInterrupt }] =
      await Promise.all([
        import("@/lib/db/execution-runs"),
        import("@/lib/execution/run-control"),
        import("@/lib/db/schema"),
        import("../db/outbox-appliers"),
      ])
    const parent = await getExecutionRun(input.parentExecutionRunId)
    if (!parent || ["completed", "failed", "cancelled"].includes(parent.status)) return false
    const existing = await getDb().executionRunInterrupts.get(input.approval.approvalId)
    if (existing) return existing.runId === input.parentExecutionRunId
    await createRunInterrupt(
      fusionApprovalInterrupt({
        executionRunId: input.parentExecutionRunId,
        fusionRunId: input.fusionRunId,
        approvalId: input.approval.approvalId,
        kind: input.approval.kind,
        requestDigest: input.approval.requestDigest,
        revision: input.approval.revision,
        logicalStepId: input.approval.logicalStepId,
        summary: { ...input.approval.summary },
        expiresAt: input.expiresAt,
        createdAt: Date.now(),
        projectId: input.projectId,
      })
    )
    return true
  },
  async withdraw(input) {
    const { expireRunInterruptFromSource } = await import("@/lib/execution/run-control")
    await expireRunInterruptFromSource(input.parentExecutionRunId, input.approvalId)
  },
}
