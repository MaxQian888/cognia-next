/**
 * The worker that runs a Router + Fusion run to its end (ADR-0188 B2–B3).
 *
 * A chat turn is a direct run whose model loop belongs to the sidecar; the
 * ledger only gates it. A run the Run API owns has no sidecar, so Router +
 * Fusion executes the whole graph itself: it takes the run's lease, replays the
 * config snapshot the run pinned, runs the mode's workflow — direct, cascade or
 * panel — against the ledger, and seals the run exactly once.
 *
 * Everything durable goes through the fusion database — the journal the SSE
 * stream replays, the reservations, the tool receipts, the answer — and the
 * cross-database effects (the `executionRuns` projection, the usage rows, the
 * session transcript) leave through the outbox, drained at start, at the seal
 * and on recovery.
 *
 * The answer is delivered verified_buffered (D7, SSE-02): the result record and
 * the answer's delivery events are committed in the same transaction as the
 * terminal event, and nothing before that carries answer text.
 *
 * The lease is heartbeaten while the run is in flight. A worker that stops
 * (a closed window, a crash) lets it lapse, and the next worker takes the run
 * over with a higher fencing token, so nothing the old one still has in flight
 * can write (REC-02); committed steps replay instead of being sent again
 * (REC-01, REC-03). A cancel from anywhere — the cockpit, the API — is noticed
 * while calls are in flight and aborts them.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import {
  answerDeliveryEvents,
  estimateTokens,
  reserveForCall,
  runCascade,
  runDirect,
  runPanel,
  usdToMicrousd,
  WorkflowError,
  type CompiledAction,
  type CompiledFusionConfig,
  type Message,
  type PanelMember,
  type PanelMemberRole,
  type RoleCallExecutor,
  type RunResult,
  type ToolRuntime,
  type VerifierProfile,
} from "@cognia/router-fusion"
import { normalizeRouterFusionSettings } from "@cognia/router-fusion/settings/settings"

import { createRoleCallExecutor } from "../calls/role-call-executor"
import type { FusionLedgerStore } from "../db/ledger-store"
import { drainFusionOutbox, type OutboxAppliers } from "../db/outbox"
import { decodeRunInput, type StoredRunInput } from "../db/run-input"
import type { FusionRunRow } from "../db/types"
import { RouterFusionInfrastructureError } from "../gate/faults"
import {
  createHostToolRuntime,
  createRunEvidenceResolver,
  PANEL_READ_POLICY,
  PANEL_VERIFY_POLICY,
} from "../tools/tool-runtime"

/** Long enough to outlive a slow model call, short enough that a dead worker is noticed. */
export const FUSION_RUN_LEASE_MS = 120_000
export const FUSION_RUN_HEARTBEAT_MS = 30_000
/** How often a running run looks for a cancel that arrived from elsewhere. */
export const FUSION_CANCEL_POLL_MS = 1_000
/** The prompt framing a role call carries on top of the task, in the reservation. */
const ROLE_OVERHEAD_TOKENS = 1_500
const JUDGE_OUTPUT_TOKENS = 4_096
const FINAL_CHECK_OUTPUT_TOKENS = 1_024
const MEMBER_TOOL_CALLS = 4
const VERIFICATION_REQUESTS = 2

export interface RunTools {
  runtime: ToolRuntime | null
  /** The policy candidates may request tools under, when any are offered. */
  memberPolicyId: string | null
  verificationPolicyId: string | null
}

export interface OrchestratorDeps {
  store: () => Promise<FusionLedgerStore>
  appliers: OutboxAppliers
  /** This worker's lease owner id — one per window or headless process. */
  leaseOwner: string
  appSettings: () => AppSettings | undefined
  /** Test seams. */
  executor?: RoleCallExecutor
  tools?: (store: FusionLedgerStore, run: FusionRunRow, action: CompiledAction) => Promise<RunTools>
  /** A reason the deployment may not be called now (AUTH-07), or null. */
  liveRefusal?: (run: FusionRunRow, deploymentId: string) => string | null
  now?: () => number
  newId?: () => string
  sleep?: (ms: number) => Promise<void>
  leaseMs?: number
  heartbeatMs?: number
  cancelPollMs?: number
}

export interface ExecuteFusionRunInput {
  runId: string
  /** The run's input. Omitted, it is read back from the run's input artifact. */
  messages?: Message[]
  /** Deliver the answer as it arrives. Only direct runs stream (D7). */
  stream?: boolean
  onDelta?: (text: string) => void
  signal?: AbortSignal
}

export type FusionRunOutcome =
  | { kind: "succeeded"; result: RunResult }
  | { kind: "failed"; code: string; message: string }
  | { kind: "cancelled" }
  /** Another worker holds this run's lease; it is not ours to execute. */
  | { kind: "busy" }

/**
 * What a run was created with. A caller that still has the messages passes
 * them; anyone else — a restarted worker, a resumed run — reads the artifact
 * the run was created with. A run with neither has nothing to send.
 */
export async function runInputFor(
  store: FusionLedgerStore,
  run: FusionRunRow,
  given: Message[] | undefined
): Promise<StoredRunInput | null> {
  const stored = run.inputArtifactId
    ? decodeRunInput((await store.artifactStore(run.runId).get(run.inputArtifactId))?.content)
    : null
  if (given && given.length > 0) {
    return {
      messages: given,
      allowDegraded: stored?.allowDegraded ?? false,
      jsonSchema: stored?.jsonSchema ?? null,
    }
  }
  return stored
}

/** The messages alone, for callers that need nothing else. */
export async function inputMessagesFor(
  store: FusionLedgerStore,
  run: FusionRunRow,
  given: Message[] | undefined
): Promise<Message[] | null> {
  return (await runInputFor(store, run, given))?.messages ?? null
}

/** The per-call reservation the route decided for this run's action. */
export function reserveForAction(
  run: FusionRunRow,
  decision: { candidates: readonly { action_id: string; reserve_cost_microusd: number }[] } | null
): number {
  const candidate = decision?.candidates.find((entry) => entry.action_id === run.actionId)
  return candidate?.reserve_cost_microusd ?? run.budget.capMicrousd
}

function sleeper(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A role's worst-case bill for one call, from the snapshot the run pinned. */
export function roleReserve(
  config: CompiledFusionConfig,
  deploymentId: string,
  inputTokens: number,
  outputTokens: number,
  unknownPriceCallReserveMicrousd: number
): number {
  const deployment = config.deploymentsById[deploymentId]
  if (!deployment) return unknownPriceCallReserveMicrousd
  return reserveForCall(
    { deployment, inputTokens, outputTokens },
    {
      rateCardsById: config.rateCardsById,
      unknownPriceCallReserveMicrousd,
      expectedOutputTokens: outputTokens,
    }
  ).microusd
}

function outputBound(config: CompiledFusionConfig, deploymentId: string, wanted: number): number {
  const max = config.deploymentsById[deploymentId]?.maxOutputTokens
  return Math.max(1, Math.min(wanted, max ?? wanted))
}

/**
 * The tools a panel run may use on this host: web evidence when the action
 * allows it and this brain can check every redirect, and the workspace the
 * person at this device chose for the conversation, when there is one.
 */
export async function hostRunTools(
  store: FusionLedgerStore,
  run: FusionRunRow,
  action: CompiledAction,
  now: () => number
): Promise<RunTools> {
  const [{ hostWebEvidence }, { hostWorkspaceReader }] = await Promise.all([
    import("../tools/web-evidence"),
    import("../tools/workspace-read"),
  ])
  const web = action.extension.web_tools_enabled ? await hostWebEvidence() : null
  const workspace = run.workspaceRoot ? await hostWorkspaceReader(run.workspaceRoot) : null
  const runtime = createHostToolRuntime({ store, runId: run.runId, web, workspace, now })
  return {
    runtime,
    memberPolicyId: runtime.describe(PANEL_READ_POLICY).length > 0 ? PANEL_READ_POLICY : null,
    verificationPolicyId: PANEL_VERIFY_POLICY,
  }
}

/** Refuse a call the account no longer allows, before it is sent (AUTH-07). */
function guardedExecutor(
  inner: RoleCallExecutor,
  refusal: (deploymentId: string) => string | null
): RoleCallExecutor {
  return {
    async call(request, signal) {
      const code = refusal(request.deploymentId)
      if (code) return { outcome: "error", errorClass: "auth", message: code }
      return inner.call(request, signal)
    },
  }
}

/**
 * Take the run and drive it to a terminal state. Returns the outcome; it never
 * throws a workflow failure at the caller, because the run's own record of what
 * happened is the answer. An infrastructure fault still propagates — the gate's
 * guard decides what an explicit run does with it (D38).
 */
export async function executeFusionRun(
  deps: OrchestratorDeps,
  input: ExecuteFusionRunInput
): Promise<FusionRunOutcome> {
  const store = await deps.store()
  const now = deps.now ?? (() => Date.now())
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID())
  const leaseMs = deps.leaseMs ?? FUSION_RUN_LEASE_MS

  const run = await store.getRun(input.runId)
  if (!run) return { kind: "failed", code: "RUN_NOT_FOUND", message: `no run ${input.runId}` }

  const lease = await store.acquireLease(input.runId, deps.leaseOwner, leaseMs)
  if (!lease.ok) {
    if (lease.code === "LEASE_HELD") return { kind: "busy" }
    return { kind: "failed", code: lease.code, message: `run ${input.runId} could not be leased` }
  }
  const { fencingToken } = lease
  // A run taken over from a lapsed lease: what the last holder left in flight
  // is settled before anything is sent, so a replayed step never goes out
  // twice (REC-03).
  await store.settleOrphanedAttempts(input.runId, fencingToken)

  const config = await store.loadRunConfig(input.runId)
  const action = config?.actions[run.actionId]
  if (!config || !action) {
    // The snapshot a run pinned is written in the same transaction as the run.
    throw new RouterFusionInfrastructureError(
      "db_transaction",
      `Router + Fusion run ${input.runId} has no config snapshot for ${run.actionId}`
    )
  }
  const extension = action.extension

  const runInput = await runInputFor(store, run, input.messages)
  if (!runInput) {
    await store.finalizeRun(input.runId, fencingToken, {
      status: "failed",
      error: { code: "RUN_INPUT_MISSING", message: "the run has no input to send" },
    })
    return { kind: "failed", code: "RUN_INPUT_MISSING", message: `run ${input.runId} has no input` }
  }
  const { messages } = runInput

  const started = await store.startRun(input.runId, fencingToken)
  if (!started.ok && started.code !== "RUN_NOT_QUEUED") {
    return { kind: "failed", code: started.code, message: `run ${input.runId} could not start` }
  }
  // Apply what creation and start queued (the cockpit row, the input in the
  // session) now rather than at the end: a run that only appears in
  // `/agent-runs` once it has finished can never be stopped from there. A
  // failed apply stays pending for the seal's drain; it never stops the run.
  await drainFusionOutbox(store.db, deps.appliers, store.outboxContext()).catch(() => undefined)

  const controller = new AbortController()
  const abort = () => controller.abort()
  // A signal that is ALREADY aborted never fires the event, so a run cancelled
  // between its creation and this worker picking it up has to be read, not
  // waited for.
  if (input.signal?.aborted) controller.abort()
  else input.signal?.addEventListener("abort", abort, { once: true })
  const heartbeat = setInterval(() => {
    void store.acquireLease(input.runId, deps.leaseOwner, leaseMs).catch(() => {})
  }, deps.heartbeatMs ?? FUSION_RUN_HEARTBEAT_MS)
  const cancelWatch = setInterval(() => {
    void store
      .getRun(input.runId)
      .then((current) => {
        if (current?.status === "cancelling") controller.abort()
      })
      .catch(() => {})
  }, deps.cancelPollMs ?? FUSION_CANCEL_POLL_MS)

  const seal = async (
    status: "succeeded" | "failed" | "cancelled",
    extra: {
      error?: { code: string; message: string }
      resultArtifactId?: string
      resultRecordArtifactId?: string
      events?: Array<{ type: string; payload: Record<string, unknown> }>
    } = {}
  ) => {
    await store.finalizeRun(input.runId, fencingToken, { status, ...extra })
    await drainFusionOutbox(store.db, deps.appliers, store.outboxContext())
  }

  try {
    const appSettings = deps.appSettings()
    if (!deps.executor && !appSettings) {
      throw new RouterFusionInfrastructureError(
        "internal",
        "Router + Fusion has no settings to resolve this run's provider credentials from"
      )
    }
    const baseExecutor =
      deps.executor ?? createRoleCallExecutor({ appSettings: appSettings as AppSettings, now })
    const liveRefusal =
      deps.liveRefusal ??
      (deps.executor ? null : await productionLiveRefusal(appSettings as AppSettings))
    const executor = liveRefusal
      ? guardedExecutor(baseExecutor, (deploymentId) => liveRefusal(run, deploymentId))
      : baseExecutor
    const unknownPriceReserve = usdToMicrousd(
      normalizeRouterFusionSettings(appSettings?.routerFusion).unknownPriceCallReserveUsd
    )
    const ports = {
      ledger: store.ledgerFor(input.runId, fencingToken),
      executor,
      events: store.eventSinkFor(input.runId, fencingToken),
      clock: { now },
      sleep: deps.sleep ?? sleeper,
      artifacts: store.artifactStore(input.runId),
      newId,
    }
    const profile = (run.acceptanceProfile ?? action.config.verifier_profile) as VerifierProfile
    const task = run.task ?? "unknown"
    const taskTokens =
      ROLE_OVERHEAD_TOKENS + messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
    const reserve = (deploymentId: string, inputTokens: number, outputTokens: number) =>
      roleReserve(config, deploymentId, inputTokens, outputTokens, unknownPriceReserve)
    const jsonSchema = runInput.jsonSchema ?? undefined

    let result: RunResult
    switch (run.mode) {
      case "direct": {
        const solver = run.roleDeployments.solver ?? Object.values(run.roleDeployments)[0]
        const out = outputBound(config, solver, extension.role_output_tokens)
        const outcome = await runDirect(ports, {
          runId: input.runId,
          deploymentId: solver,
          ...(run.roleDeployments.reviewer
            ? { reviewerDeploymentId: run.roleDeployments.reviewer }
            : {}),
          messages,
          maxOutputTokens: out,
          reserveMicrousd: reserve(solver, taskTokens, out),
          transportAttempts: extension.limits.transport_attempts_per_call,
          maxFormatRepairs: extension.limits.max_format_repairs,
          deadlineAt: run.deadlineAt,
          profile,
          task,
          deliversChange: false,
          ...(jsonSchema ? { jsonSchema } : {}),
          toolPolicyId: null,
          stream: input.stream === true,
          signal: controller.signal,
          ...(input.onDelta ? { onDelta: input.onDelta } : {}),
        })
        result = outcome.result
        break
      }
      case "cascade": {
        const cheap = run.roleDeployments.cheap
        const strong = run.roleDeployments.strong
        if (!cheap || !strong)
          throw new WorkflowError("ROLE_UNRESOLVABLE", "the cascade has no cheap or strong role")
        const reviewer = run.roleDeployments.reviewer ?? strong
        const out = Math.min(
          outputBound(config, cheap, extension.role_output_tokens),
          outputBound(config, strong, extension.role_output_tokens)
        )
        const outcome = await runCascade(ports, {
          runId: input.runId,
          cheapDeploymentId: cheap,
          strongDeploymentId: strong,
          ...(run.roleDeployments.reviewer ? { reviewerDeploymentId: reviewer } : {}),
          messages,
          maxOutputTokens: out,
          reserveMicrousd: {
            cheap: reserve(cheap, taskTokens, out),
            // The strong call carries the failure report too.
            strong: reserve(strong, taskTokens + Math.ceil(out / 4), out),
            reviewer: reserve(reviewer, taskTokens + out, 1_024),
          },
          transportAttempts: extension.limits.transport_attempts_per_call,
          maxFormatRepairs: extension.limits.max_format_repairs,
          deadlineAt: run.deadlineAt,
          profile,
          task,
          deliversChange: false,
          allowDegraded: runInput.allowDegraded,
          ...(jsonSchema ? { jsonSchema } : {}),
          signal: controller.signal,
        })
        result = outcome.result
        break
      }
      case "panel": {
        const members: PanelMember[] = (["panel_a", "panel_b", "panel_c"] as PanelMemberRole[])
          .filter((role) => run.roleDeployments[role])
          .map((role) => ({
            role,
            deploymentId: run.roleDeployments[role],
            contextLimit: config.deploymentsById[run.roleDeployments[role]]?.contextLimit ?? 32_000,
          }))
          .slice(0, extension.limits.panel_size)
        const judge = run.roleDeployments.judge
        const synthesizer = run.roleDeployments.synthesizer
        if (!judge || !synthesizer || members.length === 0) {
          throw new WorkflowError(
            "ROLE_UNRESOLVABLE",
            "the panel is missing a member, its judge or its synthesizer"
          )
        }
        const tools = await (deps.tools ?? ((s, r, a) => hostRunTools(s, r, a, now)))(
          store,
          run,
          action
        )
        const memberOut = Math.min(
          ...members.map((member) =>
            outputBound(config, member.deploymentId, extension.role_output_tokens)
          )
        )
        const outcome = await runPanel(
          {
            ...ports,
            evidence: createRunEvidenceResolver(store, input.runId, now),
            ...(tools.runtime ? { tools: tools.runtime } : {}),
          },
          {
            runId: input.runId,
            members,
            judge: {
              deploymentId: judge,
              contextLimit: config.deploymentsById[judge]?.contextLimit ?? 32_000,
            },
            synthesizer: {
              deploymentId: synthesizer,
              contextLimit: config.deploymentsById[synthesizer]?.contextLimit ?? 32_000,
            },
            messages,
            commonEvidence: [],
            outputTokens: {
              member: memberOut,
              judge: outputBound(config, judge, JUDGE_OUTPUT_TOKENS),
              synthesizer: outputBound(config, synthesizer, extension.role_output_tokens),
              finalCheck: outputBound(config, judge, FINAL_CHECK_OUTPUT_TOKENS),
            },
            reserveFor: (_role, deploymentId, inputTokens, outputTokens) =>
              reserve(deploymentId, inputTokens, outputTokens),
            limits: {
              minCandidates: extension.limits.panel_min_candidates,
              evidenceRounds: extension.limits.panel_evidence_rounds,
              maxFormatRepairs: extension.limits.max_format_repairs,
              transportAttempts: extension.limits.transport_attempts_per_call,
              memberToolCalls: MEMBER_TOOL_CALLS,
              verificationRequests: VERIFICATION_REQUESTS,
            },
            profile,
            task,
            deliversChange: false,
            allowDegraded: runInput.allowDegraded,
            memberToolPolicyId: tools.memberPolicyId,
            verificationToolPolicyId: tools.runtime ? tools.verificationPolicyId : null,
            ...(jsonSchema ? { jsonSchema } : {}),
            deadlineAt: run.deadlineAt,
            signal: controller.signal,
          }
        )
        result = outcome.result
        break
      }
      default:
        throw new WorkflowError(
          "MODE_NOT_AVAILABLE",
          `this build does not execute ${run.mode} runs`
        )
    }

    const { answer: _answer, ...record } = result
    const recordArtifact = await store
      .artifactStore(input.runId)
      .put(JSON.stringify(record), "application/json", `runs/${input.runId}/result`)
    await seal("succeeded", {
      resultArtifactId: result.answer_artifact_id,
      resultRecordArtifactId: recordArtifact.artifactId,
      events: answerDeliveryEvents(result, recordArtifact.artifactId),
    })
    return { kind: "succeeded", result }
  } catch (error) {
    if (error instanceof RouterFusionInfrastructureError) {
      // The run is not sealed here: the money and the attempts are still
      // whatever the database says, and recovery reconciles them.
      throw error
    }
    if (error instanceof WorkflowError) {
      if (error.code === "CANCELLED") {
        await seal("cancelled")
        return { kind: "cancelled" }
      }
      await seal("failed", { error: { code: error.code, message: error.message } })
      return { kind: "failed", code: error.code, message: error.message }
    }
    const message = error instanceof Error ? error.message : String(error)
    await seal("failed", { error: { code: "INTERNAL", message } })
    return { kind: "failed", code: "INTERNAL", message }
  } finally {
    clearInterval(heartbeat)
    clearInterval(cancelWatch)
    input.signal?.removeEventListener("abort", abort)
  }
}

/**
 * The live check the chat path runs before every reservation, for a run this
 * host executes: the provider is still enabled, restricted data still has its
 * grant, and the surface is still switched on.
 */
async function productionLiveRefusal(
  appSettings: AppSettings
): Promise<(run: FusionRunRow, deploymentId: string) => string | null> {
  const [{ utilityRouteHost }, { liveRefusalFor }] = await Promise.all([
    import("../calls/ledgered-llm-client"),
    import("../chat/route-chat-turn"),
  ])
  const host = utilityRouteHost(appSettings)
  return (run, deploymentId) =>
    liveRefusalFor(host, deploymentId, run.dataClass ?? "internal", run.surface)
}
