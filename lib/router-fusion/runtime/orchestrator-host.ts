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
  delegateLimitsOf,
  DELEGATE_WORK_POLICY,
  delegatePatchSha256,
  estimateTokens,
  reserveForCall,
  runCascade,
  runDelegateWorkflow,
  runDirect,
  runPanel,
  SideEffectOutcomeUnknownError,
  usdToMicrousd,
  WorkflowError,
  type CompiledAction,
  type CompiledFusionConfig,
  type DelegateDelivery,
  type DelegatePendingApproval,
  type DelegateRunOutcome,
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
import { createDelegateApprovalPort } from "./delegate-approvals"
import type { DelegateHostPorts } from "./delegate-host-ports"
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
/** A delegate reviewer judges a change; it does not rewrite one. */
const DELEGATE_REVIEW_OUTPUT_TOKENS = 2_048

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
  /**
   * The delegate run's four device ports, built as one so the acceptance
   * runner verifies the very trees the workspace port staged (WP-D3). A test
   * substitutes a fake filesystem and sandbox here; production builds them
   * from the run's project.
   */
  delegatePorts?: (store: FusionLedgerStore, run: FusionRunRow) => Promise<DelegateHostPorts>
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
   * The run is parked on a person (delegate only, D21). It is NOT sealed: its
   * money stays held, its journal stays replayable, and resuming it runs the
   * same graph again from the steps it committed. `code` and `message` are
   * carried so a caller that only knows "not succeeded" still has something
   * true to say.
   */
  | {
      kind: "waiting"
      code: "WAITING_FOR_APPROVAL"
      message: string
      approval: DelegatePendingApproval
    }
  /**
   * A side effect was dispatched and its outcome is unknown (REC-06). The run
   * is in `reconciling` with a `human_handoff` interrupt — never sealed as a
   * failure, because a patch may be on disk and tests may have run.
   */
  | { kind: "reconciling"; code: string; message: string }

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
  now: () => number,
  /** A delegate run's ports, already built: its tools come from them. */
  delegate?: DelegateHostPorts
): Promise<RunTools> {
  if (action.config.mode === "delegate") {
    if (!delegate) {
      throw new WorkflowError(
        "DELEGATE_TOOLS_UNAVAILABLE",
        "a delegate run needs its workspace ports before its tools"
      )
    }
    // One runtime, over the same workspace port the acceptance runner
    // verifies: read, list and propose-patch under `delegate-work-1`, and
    // nothing else — no web, no panel file reader.
    return {
      runtime: delegate.tools,
      memberPolicyId: DELEGATE_WORK_POLICY,
      verificationPolicyId: null,
    }
  }
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

/**
 * A delegate run's four device ports (ADR-0188 B4, WP-D3), built from what the
 * run itself pinned: its project, its checkout, and the acceptance profile it
 * was routed with.
 *
 * The journal is the durable one — `fusionDelegateSteps` through the run's own
 * content codec — not the in-memory default. That is the difference between a
 * run that can be resumed after an approval or a reload and one that finds no
 * steps and refuses to repeat the ones it cannot repeat safely (REC-06).
 */
export async function hostDelegatePorts(
  store: FusionLedgerStore,
  run: FusionRunRow,
  now: () => number,
  newId: () => string
): Promise<DelegateHostPorts> {
  const context = delegateRunContext(run)
  const [{ createDelegateHostPorts }, { createFusionDelegateStepStore }] = await Promise.all([
    import("./delegate-host-ports"),
    import("../db/delegate-store"),
  ])
  return createDelegateHostPorts({
    runId: run.runId,
    projectId: context.projectId,
    workspaceRoot: context.workspaceRoot,
    acceptanceProfileId: context.acceptanceProfileId,
    store,
    now,
    newId,
    configRoot: context.workspaceRoot,
    journalStore: createFusionDelegateStepStore(store.db, store.contentCodec),
  })
}

/**
 * What a delegate run must carry before anything is delegated: the project its
 * acceptance profile belongs to, the checkout it reads and (only with an
 * approval) writes, and the profile id itself.
 *
 * The router does not offer delegate without them, so reaching here without
 * one is a wiring fault, not a user error — it fails loudly with the field
 * that is missing rather than running a graph that cannot verify anything.
 */
export function delegateRunContext(run: FusionRunRow): {
  projectId: string
  workspaceRoot: string
  acceptanceProfileId: string
} {
  const missing: string[] = []
  if (!run.projectId) missing.push("projectId")
  if (!run.workspaceRoot) missing.push("workspaceRoot")
  if (!run.acceptanceProfileId) missing.push("acceptanceProfileId")
  if (missing.length > 0) {
    throw new WorkflowError(
      "WORKSPACE_REQUIRED",
      `a delegate run needs ${missing.join(", ")}; this one has none`,
      { missing }
    )
  }
  return {
    projectId: run.projectId as string,
    workspaceRoot: run.workspaceRoot as string,
    acceptanceProfileId: run.acceptanceProfileId as string,
  }
}

/**
 * Index the change a finished delegate run produced (`fusionPatchSets`).
 *
 * The patch itself is already an artifact; this row is what the review pane
 * lists and what an approved apply marks as landed. Failing to write it must
 * never fail a run that succeeded — the patch is still readable by its
 * artifact id — so it is recorded best-effort and the reason is kept on the
 * run's journal instead.
 */
async function recordDelegatePatchSet(
  store: FusionLedgerStore,
  runId: string,
  outcome: Extract<DelegateRunOutcome, { kind: "completed" }>,
  now: number
): Promise<void> {
  try {
    const { recordPatchSet } = await import("../db/delegate-store")
    const { PATCH_SET_TTL_MS } = await import("../db/retention")
    const { DelegatePatchSchema } = await import("@cognia/router-fusion")
    const stored = await store.artifactStore(runId).get(outcome.patchArtifactId)
    if (!stored) return
    const patch = DelegatePatchSchema.parse(JSON.parse(stored.content))
    await recordPatchSet(store.db, {
      runId,
      baseRevision: patch.base_revision,
      resultRevision: outcome.resultRevision,
      patchSha256: delegatePatchSha256(patch),
      patchArtifactId: outcome.patchArtifactId,
      paths: patch.files.map((file) => file.path),
      delivery: outcome.deliveredRevision === null ? "patch_only" : "workspace_updated",
      now,
      ttlMs: PATCH_SET_TTL_MS,
    })
  } catch {
    // Indexing is a convenience over durable data, never the durable data.
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

  // A delegate run holds two worktrees while it works. They are given back
  // when it REACHES A TERMINAL STATE, never when it parks: a run waiting for a
  // person still owns the tree the approval is about.
  let delegateWorkspace: DelegateHostPorts["workspace"] | null = null
  let parked = false

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
      case "delegate": {
        const lead = run.roleDeployments.lead
        const worker = run.roleDeployments.worker
        if (!lead || !worker) {
          throw new WorkflowError("ROLE_UNRESOLVABLE", "the delegate has no lead or worker role")
        }
        // Throws with the field that is missing rather than running a graph
        // that could never verify anything.
        const context = delegateRunContext(run)
        const hostPorts = await (
          deps.delegatePorts ?? ((s, r) => hostDelegatePorts(s, r, now, newId))
        )(store, run)
        delegateWorkspace = hostPorts.workspace
        const tools = await (deps.tools ?? ((s, r, a) => hostRunTools(s, r, a, now, hostPorts)))(
          store,
          run,
          action
        )
        if (!tools.runtime) {
          throw new WorkflowError(
            "DELEGATE_TOOLS_UNAVAILABLE",
            "the delegate worker has no tool runtime"
          )
        }
        const approvals = createDelegateApprovalPort({
          store,
          runId: input.runId,
          projectId: context.projectId,
          now,
        })
        const reviewer = run.roleDeployments.reviewer ?? null
        const roleOf = (deploymentId: string) => ({
          deploymentId,
          contextLimit: config.deploymentsById[deploymentId]?.contextLimit ?? 32_000,
        })
        const outcome: DelegateRunOutcome = await runDelegateWorkflow(
          {
            ...ports,
            tools: tools.runtime as DelegateHostPorts["tools"],
            workspace: hostPorts.workspace,
            acceptance: hostPorts.acceptance,
            approvals,
            journal: hostPorts.journal,
          },
          {
            runId: input.runId,
            lead: roleOf(lead),
            worker: roleOf(worker),
            ...(reviewer ? { reviewer: roleOf(reviewer) } : {}),
            messages,
            acceptanceProfileId: context.acceptanceProfileId,
            outputTokens: {
              lead: outputBound(config, lead, extension.role_output_tokens),
              worker: outputBound(config, worker, extension.role_output_tokens),
              reviewer: outputBound(config, reviewer ?? lead, DELEGATE_REVIEW_OUTPUT_TOKENS),
            },
            reserveFor: (_role, deploymentId, inputTokens, outputTokens) =>
              reserve(deploymentId, inputTokens, outputTokens),
            limits: delegateLimitsOf(extension.limits),
            task,
            allowDegraded: runInput.allowDegraded,
            // `workspace_updated` writes into the person's own checkout and is
            // only ever reached through an approval the DELIVER step asks for.
            // No surface sets it yet (see `FusionRunRow.delegateDelivery`).
            delivery: run.delegateDelivery ?? "patch_only",
            deadlineAt: run.deadlineAt,
            signal: controller.signal,
          }
        )
        if (outcome.kind === "waiting_for_approval") {
          // Park, do not seal: the money stays held, the journal stays
          // replayable, and the very same input runs again when a person
          // answers. Sealing here would tell the caller the run did nothing
          // while a decision was still outstanding.
          parked = true
          const paused = await store.pauseRun(input.runId, fencingToken, "waiting_for_approval", {
            approval: {
              approvalId: outcome.approval.approvalId,
              requestDigest: outcome.approval.requestDigest,
              kind: outcome.approval.kind,
              revision: outcome.approval.revision,
              logicalStepId: outcome.approval.logicalStepId,
              summary: { ...outcome.approval.summary },
            },
          })
          if (!paused.ok) {
            parked = false
            throw new WorkflowError(
              "RUN_NOT_PARKED",
              `the run could not be parked for approval: ${paused.code}`
            )
          }
          // Drain now: an approval nobody can see is an approval nobody gives.
          await drainFusionOutbox(store.db, deps.appliers, store.outboxContext()).catch(
            () => undefined
          )
          return {
            kind: "waiting",
            code: "WAITING_FOR_APPROVAL",
            message: `the run is waiting for a person to decide ${outcome.approval.kind}`,
            approval: outcome.approval,
          }
        }
        await recordDelegatePatchSet(store, input.runId, outcome, now())
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
    // REC-06: a side effect that was dispatched and never answered. A failed
    // seal would be a lie — a patch may be on disk and an acceptance command
    // may have run — and a retry would be worse. The run goes to
    // reconciliation with a handoff for a person, keeps its money held, and
    // the step is NEVER sent again.
    if (error instanceof SideEffectOutcomeUnknownError) {
      const reconciled = await store.reconcileRun(input.runId, fencingToken, {
        code: error.code,
        logicalStepId: (error.details.logical_step_id as string | undefined) ?? null,
        sideEffect: (error.details.side_effect as string | undefined) ?? null,
      })
      await drainFusionOutbox(store.db, deps.appliers, store.outboxContext()).catch(() => undefined)
      if (reconciled.ok) {
        // Reconciling is not terminal: the worktrees stay until a person has
        // decided what happened to the change they may already hold.
        parked = true
        return { kind: "reconciling", code: error.code, message: error.message }
      }
      // The run could not even be moved there (fenced, or already gone): fall
      // through to the ordinary workflow failure rather than claiming a
      // reconciliation that is not recorded.
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
    if (delegateWorkspace && !parked) {
      await delegateWorkspace.dispose().catch(() => undefined)
    }
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
