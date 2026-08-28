/**
 * Run a host-owned external agent for a client that cannot run one itself.
 *
 * This is the execution half of the host-owned configuration plane. The
 * browser holds the Composer and the host holds the process, so a turn crosses
 * the boundary three times: the client asks, the host runs and streams back,
 * and the client answers whatever the agent stops to ask about. Each of those
 * legs reuses something that already exists rather than inventing a peer:
 *
 *   - **Admission** is `admitExternalAgentRun` — the stamp check plus the live
 *     readiness re-derivation, which also hands back the leased revision. The
 *     configuration that mounts is the one the host stored, never the one the
 *     caller sent.
 *   - **Execution** is `ExternalAgentManager.execute`, the same call the
 *     desktop Composer makes. A remote turn is not a different product.
 *   - **Delivery** is `publishHostEvent`, which resolves to a Tauri `emit` on
 *     the desktop and to `companion_event_publish` on the brain, then rides the
 *     companion `EventBus` — whose frames already carry a monotonic sequence
 *     and a replay-from-cursor subscription. There is no second event bridge
 *     here because there does not need to be one.
 *
 * What this module genuinely adds is the run's own bookkeeping: which revision
 * is mounted, a per-run sequence so a client can dedupe a replayed frame, one
 * authoritative terminal event, and a decision registry that makes an answer
 * one-time and device-scoped.
 */

import { publishHostEvent } from "@/lib/companion/host-event-publisher"
import type {
  AcpElicitationResponse,
  AcpPermissionOption,
  AcpPermissionResponse,
  ExternalAgentConfig,
  ExternalAgentEvent,
} from "@/types/agent/external-agent"
import type { ExternalAgentConfigStamp } from "@/types/agent/external-agent-config-store"
import type { ApprovalDecision } from "@cognia/agent-config-types"

import { admitExternalAgentRun, releaseExternalAgentRun } from "./run-admission"
import type { RunAdmissionRefusal } from "./run-admission"
import { pickPermissionOptionId } from "./chat-decision-bridge"

/** The channel every frame of a remote external run is published on. */
export const EXTERNAL_RUN_EVENT_TOPIC = "external-agent://session-event"

/**
 * How long a question waits for an answer before the host decides for the user.
 *
 * A remote client can close its tab mid-turn, and the agent would then hold a
 * process open forever waiting for a permission that is never coming. Denying
 * is the only safe expiry: the alternative — timing out into an allow — would
 * turn "the user walked away" into "the user consented".
 */
export const DECISION_TIMEOUT_MS = 120_000

export interface RemoteRunRequest {
  runId: string
  /** The client's chat session. Frames are addressed to it, not to the agent's. */
  chatSessionId: string
  stamp: ExternalAgentConfigStamp
  prompt: string
  /** Resume an agent session this run already created. */
  externalSessionId?: string
  /**
   * The authenticated caller, injected host-side by the RPC layer. Recorded so
   * a decision can only be answered by the device that was shown the question.
   */
  callerDeviceId?: string
}

/** One frame on the wire. */
export interface RemoteRunFrame {
  runId: string
  chatSessionId: string
  /**
   * Per-run and monotonic from 1. The bus has its own global sequence and its
   * own replay cursor — this exists so a client can tell whether a frame it is
   * seeing is one it already applied, which the bus cursor alone cannot answer
   * once frames from other topics are interleaved.
   */
  seq: number
  event: ExternalAgentEvent
  /** Set on the single frame that ends the run. */
  terminal?: "completed" | "failed" | "cancelled"
  /** Present on `failed`. Never carries a stack or a host path. */
  error?: string
}

export type RemoteRunStart =
  | { started: true; runId: string; agentId: string }
  | { started: false; refusal: RunAdmissionRefusal }

// ---------------------------------------------------------------------------
// Run + decision state
// ---------------------------------------------------------------------------

interface PendingDecision {
  runId: string
  kind: "permission" | "elicitation"
  agentId: string
  /** The agent's own session id — where the answer has to be delivered. */
  externalSessionId: string
  /** The id the adapter is waiting on. */
  responseRequestId: string
  /** Only this device may answer. Undefined when the host started the run. */
  deviceId?: string
  options?: AcpPermissionOption[]
  timer: ReturnType<typeof setTimeout>
}

interface ActiveRun {
  runId: string
  chatSessionId: string
  agentId: string
  revision: string
  deviceId?: string
  seq: number
  /** Set by whichever path ends the run first; the fence for the rest. */
  settled: boolean
  externalSessionId?: string
  cancel?: () => void
  /**
   * The tail of this run's publish chain. Frames are appended to it rather
   * than published concurrently, because two in-flight publishes can reach the
   * bus in either order and the client drops any frame whose `seq` it has
   * already passed — so an overtaken frame would be lost, not reordered.
   */
  publishing: Promise<void>
}

const runs = new Map<string, ActiveRun>()
const decisions = new Map<string, PendingDecision>()
/** configId → the revision currently mounted on the manager. */
const mounted = new Map<string, string>()
/** configId → the mount in flight, so two runs cannot interleave a teardown. */
const mounting = new Map<string, Promise<string>>()

export interface RemoteRunDeps {
  admit: typeof admitExternalAgentRun
  release: typeof releaseExternalAgentRun
  publish: (topic: string, payload: unknown) => Promise<void>
  getManager: () => Promise<ExternalRunManager>
  now: () => number
}

/** The slice of `ExternalAgentManager` this module uses. */
export interface ExternalRunManager {
  getAgent(agentId: string): unknown | undefined
  addAgent(config: ExternalAgentConfig, options?: { connect?: boolean }): Promise<unknown>
  removeAgent(agentId: string): Promise<void>
  execute(
    agentId: string,
    prompt: string,
    options?: {
      sessionId?: string
      onEvent?: (event: ExternalAgentEvent) => void
      signal?: AbortSignal
    }
  ): Promise<unknown>
  respondToPermission(
    agentId: string,
    sessionId: string,
    response: AcpPermissionResponse
  ): Promise<void>
  respondToElicitation(agentId: string, response: AcpElicitationResponse): Promise<void>
}

const defaultDeps: RemoteRunDeps = {
  admit: admitExternalAgentRun,
  release: releaseExternalAgentRun,
  publish: publishHostEvent,
  getManager: async () => {
    const { getExternalAgentManager } = await import("./manager")
    return getExternalAgentManager() as unknown as ExternalRunManager
  },
  now: () => Date.now(),
}

let deps: RemoteRunDeps = defaultDeps

/** Test seam — returns a restore function. */
export function __setRemoteRunDepsForTests(next: Partial<RemoteRunDeps>): () => void {
  const previous = deps
  deps = { ...deps, ...next }
  return () => {
    deps = previous
  }
}

/** Test seam — forget every run, decision and mount. */
export function __resetRemoteRunStateForTests(): void {
  for (const decision of decisions.values()) clearTimeout(decision.timer)
  runs.clear()
  decisions.clear()
  mounted.clear()
  mounting.clear()
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

/**
 * Make the manager hold exactly the admitted revision for this configuration.
 *
 * The agent id is the configuration id, so a second run against the same
 * configuration reuses the connected process instead of spawning a rival. A
 * revision change tears the agent down first: leaving the old one mounted
 * would run the previous command line under the new configuration's name,
 * which is the failure the revision check exists to prevent.
 *
 * Nothing here installs a runtime or a plugin. Admission already refused
 * anything that is not ready; if the adapter is missing at this point that is
 * an error to report, not a gap to fill.
 *
 * Mounts for one configuration are serialized (see {@link mountAgent}): the
 * read of `mounted`, the teardown and the re-add are one critical section, so
 * two runs starting at once cannot both pass the `getAgent` check and both
 * call `addAgent`.
 */
async function mountAgentExclusive(
  manager: ExternalRunManager,
  configId: string,
  revision: string,
  config: ExternalAgentConfig
): Promise<string> {
  const agentId = configId
  const current = mounted.get(configId)
  if (current === revision && manager.getAgent(agentId)) return agentId

  // A revision change still tears the old agent down even when another run is
  // mid-turn on it: leaving it mounted would run the previous command line
  // under the new revision's name, which is the failure the revision check
  // exists to prevent, and losing a turn is the lesser harm. That run settles
  // as `failed` when its `execute` rejects.
  if (manager.getAgent(agentId)) {
    await manager.removeAgent(agentId)
    mounted.delete(configId)
  }
  await manager.addAgent({ ...config, id: agentId }, { connect: true })
  mounted.set(configId, revision)
  return agentId
}

/**
 * Serialize {@link mountAgentExclusive} per configuration.
 *
 * Chained rather than locked so a caller never has to poll: each mount waits
 * for the previous one to finish before it reads `mounted`. A failed mount is
 * swallowed by the chain (`.catch`) so it does not poison the next run's turn;
 * the failure is still returned to its own caller.
 */
async function mountAgent(
  manager: ExternalRunManager,
  configId: string,
  revision: string,
  config: ExternalAgentConfig
): Promise<string> {
  const previous = mounting.get(configId)
  const next = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
    mountAgentExclusive(manager, configId, revision, config)
  )
  mounting.set(configId, next)
  try {
    return await next
  } finally {
    // Only the tail clears the slot; a later mount already queued behind this
    // one owns it now.
    if (mounting.get(configId) === next) mounting.delete(configId)
  }
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/**
 * Publish one frame, in `seq` order.
 *
 * The sequence is assigned synchronously, but the publish itself is appended
 * to the run's chain rather than started immediately: the bus is reached over
 * a transport that does not promise to deliver two concurrent sends in the
 * order they were made, and the client treats a frame whose `seq` it has
 * already passed as a replay and DROPS it. An overtaken frame would therefore
 * be lost outright, so the ordering has to hold on this side.
 *
 * Returns the promise for THIS frame; a rejection is the caller's to handle.
 * The chain itself absorbs the failure so one unpublishable frame does not
 * poison every later one, including the terminal frame.
 */
function emit(
  run: ActiveRun,
  event: ExternalAgentEvent,
  terminal?: RemoteRunFrame["terminal"],
  error?: string
): Promise<void> {
  run.seq += 1
  const frame: RemoteRunFrame = {
    runId: run.runId,
    chatSessionId: run.chatSessionId,
    seq: run.seq,
    event,
    ...(terminal ? { terminal } : {}),
    ...(error ? { error } : {}),
  }
  const published = run.publishing.then(() => deps.publish(EXTERNAL_RUN_EVENT_TOPIC, frame))
  run.publishing = published.catch(() => undefined)
  return published
}

const TERMINAL_REASON = {
  completed: "completed",
  failed: "error",
  cancelled: "cancelled",
} as const

/**
 * End the run exactly once.
 *
 * Every path that can finish a turn calls this — the adapter's own
 * `session_end`, a thrown execute, an explicit cancel, a disconnect — and the
 * `settled` flag is what keeps a client from seeing two contradictory endings
 * for one run. The lease is released here and only here.
 *
 * The release is in a `finally` because it is the only thing that can undo it:
 * the run is already out of `runs`, so a throw from the terminal publish would
 * leave the revision leased by a run nobody can reach, and
 * `collectExternalAgentConfigRevisions` never collects a leased revision.
 */
async function settle(
  run: ActiveRun,
  terminal: Exclude<RemoteRunFrame["terminal"], undefined>,
  error?: string
): Promise<void> {
  if (run.settled) return
  run.settled = true
  releaseDecisionsForRun(run.runId, "abandoned")
  runs.delete(run.runId)
  try {
    // A synthesized `session_end` rather than whatever the adapter last said.
    // The adapter emits one only on the paths it knows about — a thrown
    // execute, an abort and a dropped connection all end the turn without it —
    // so the client would otherwise have to infer the ending from silence.
    await emit(
      run,
      {
        type: "session_end",
        sessionId: run.externalSessionId,
        timestamp: new Date(deps.now()),
        reason: TERMINAL_REASON[terminal],
        ...(error ? { error } : {}),
      },
      terminal,
      error
    )
  } finally {
    await deps.release(run.runId)
  }
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** The chat-side id for one question. Unique per run so two runs cannot collide. */
export function remoteDecisionId(runId: string, responseRequestId: string): string {
  return `${runId}:${responseRequestId}`
}

function registerDecision(run: ActiveRun, event: ExternalAgentEvent): void {
  const kind = event.type === "permission_request" ? "permission" : "elicitation"
  const request = (event as { request?: Record<string, unknown> }).request
  const responseRequestId =
    kind === "permission"
      ? (request?.requestId as string) || (request?.id as string) || ""
      : (request?.id as string) || ""
  if (!responseRequestId) return

  const externalSessionId =
    ((event as { sessionId?: string }).sessionId ||
      (request?.sessionId as string) ||
      run.externalSessionId) ??
    ""
  const id = remoteDecisionId(run.runId, responseRequestId)
  if (decisions.has(id)) return

  const timer = setTimeout(() => {
    void expireDecision(id)
  }, DECISION_TIMEOUT_MS)
  // Node keeps the event loop alive for a pending timer, which would stop a
  // brain process from exiting for two minutes after its last turn.
  ;(timer as { unref?: () => void }).unref?.()

  decisions.set(id, {
    runId: run.runId,
    kind,
    agentId: run.agentId,
    externalSessionId,
    responseRequestId,
    deviceId: run.deviceId,
    options: request?.options as AcpPermissionOption[] | undefined,
    timer,
  })
}

function forget(id: string): PendingDecision | undefined {
  const decision = decisions.get(id)
  if (!decision) return undefined
  clearTimeout(decision.timer)
  decisions.delete(id)
  return decision
}

function releaseDecisionsForRun(runId: string, _reason: "abandoned"): void {
  for (const [id, decision] of decisions) {
    if (decision.runId !== runId) continue
    clearTimeout(decision.timer)
    decisions.delete(id)
  }
}

/** The answer sent when nobody answered. Deny, never allow. See the constant. */
async function expireDecision(id: string): Promise<void> {
  const decision = forget(id)
  if (!decision) return
  const manager = await deps.getManager()
  try {
    if (decision.kind === "permission") {
      await manager.respondToPermission(decision.agentId, decision.externalSessionId, {
        requestId: decision.responseRequestId,
        granted: false,
        optionId: pickPermissionOptionId("deny", decision.options),
      })
    } else {
      await manager.respondToElicitation(decision.agentId, {
        requestId: decision.responseRequestId,
        action: "cancel",
      })
    }
  } catch {
    // The agent is usually already gone — that is often WHY nobody answered.
  }
}

export type ResolveDecisionOutcome =
  { resolved: true } | { resolved: false; reason: "unknown" | "wrong-device" }

/**
 * Answer one question.
 *
 * Refuses an id it does not hold — which covers a replay, an expiry that
 * already fired, and a run that has since settled — and refuses a device other
 * than the one the question was addressed to. Both are `resolved: false` rather
 * than a throw: neither is an error on the host, and the client needs to tell
 * them apart to know whether to re-read or to give up.
 */
export async function resolveRemoteDecision(input: {
  decisionId: string
  callerDeviceId?: string
  decision?: ApprovalDecision
  elicitation?: AcpElicitationResponse
}): Promise<ResolveDecisionOutcome> {
  const held = decisions.get(input.decisionId)
  if (!held) return { resolved: false, reason: "unknown" }
  if (held.deviceId && input.callerDeviceId !== held.deviceId) {
    // Deliberately left pending: the rightful device may still answer, and
    // consuming it here would let any paired device cancel someone else's turn.
    return { resolved: false, reason: "wrong-device" }
  }

  forget(input.decisionId)
  const manager = await deps.getManager()
  if (held.kind === "permission") {
    const decision: ApprovalDecision = input.decision ?? "deny"
    await manager.respondToPermission(held.agentId, held.externalSessionId, {
      requestId: held.responseRequestId,
      granted: decision !== "deny",
      ...(decision === "allow_always" ? { rememberChoice: true, scope: "session" as const } : {}),
      optionId: pickPermissionOptionId(decision, held.options),
    })
  } else {
    await manager.respondToElicitation(held.agentId, {
      ...(input.elicitation ?? { action: "cancel" }),
      requestId: held.responseRequestId,
    })
  }
  return { resolved: true }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Admit, mount and start a turn. Resolves as soon as the run is *accepted* —
 * the turn itself streams over the event topic, because a client that had to
 * hold an RPC open for the whole turn would lose it to any reconnect.
 *
 * A `runId` already streaming is refused rather than replaced. The id is the
 * client's only handle on the turn, and both runs would share it: the first to
 * settle would delete the other's entry from `runs` and release the lease it
 * is still executing under, after which its cancel answers "nothing to stop"
 * and its revision is collectable out from under it.
 */
export async function startRemoteExternalRun(request: RemoteRunRequest): Promise<RemoteRunStart> {
  if (runs.has(request.runId)) {
    throw new Error(`external agent run ${request.runId} is already active`)
  }
  const admission = await deps.admit(request.runId, request.stamp)
  if (!admission.ok) return { started: false, refusal: admission.refusal }

  const manager = await deps.getManager()
  const record = admission.run.record
  let agentId: string
  try {
    agentId = await mountAgent(
      manager,
      record.configId,
      record.revision,
      admission.run.config as unknown as ExternalAgentConfig
    )
  } catch (cause) {
    // The lease is dropped here rather than left for the settle path: no run
    // exists to settle, so nothing else would ever release it.
    await deps.release(request.runId)
    return {
      started: false,
      refusal: {
        kind: "readiness",
        status: "blocked",
        reason: cause instanceof Error ? cause.message : String(cause),
        current: record,
      },
    }
  }

  const controller = new AbortController()
  const run: ActiveRun = {
    runId: request.runId,
    chatSessionId: request.chatSessionId,
    agentId,
    revision: record.revision,
    deviceId: request.callerDeviceId,
    seq: 0,
    settled: false,
    externalSessionId: request.externalSessionId,
    cancel: () => controller.abort(),
    publishing: Promise.resolve(),
  }
  runs.set(run.runId, run)

  // Not awaited: the RPC answers "accepted" and the turn streams.
  //
  // Every floating promise below carries its own `.catch`. This runs on hosts
  // where an unhandled rejection is fatal (Node's default is to throw), so a
  // bus that rejects one frame mid-turn would take the whole brain down
  // instead of costing that frame.
  void (async () => {
    try {
      await manager.execute(agentId, request.prompt, {
        sessionId: request.externalSessionId,
        signal: controller.signal,
        onEvent: (event) => {
          if (run.settled) return
          if (event.type === "session_start") {
            run.externalSessionId = (event as { sessionId?: string }).sessionId
          }
          if (event.type === "permission_request" || event.type === "elicitation_request") {
            registerDecision(run, event)
          }
          // A dropped frame is a hole the client can see (its `seq` gap) and
          // recover from; a crashed host is neither.
          void emit(run, event).catch(() => undefined)
        },
      })
      await settle(run, "completed")
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      await settle(run, controller.signal.aborted ? "cancelled" : "failed", message)
    }
  })().catch(() => {
    // `settle` itself can reject through the terminal publish. It has already
    // released the lease by then (its `finally`), so there is nothing left to
    // undo — and rethrowing here is the crash this catch exists to prevent.
  })

  return { started: true, runId: run.runId, agentId }
}

/**
 * Stop a run.
 *
 * Answers `true` only when a run was actually stopped, so a client can tell
 * "I cancelled it" from "it had already finished" — which matters because the
 * second means a terminal frame is already on its way and the first means the
 * cancel produced one.
 */
export async function cancelRemoteExternalRun(
  runId: string,
  callerDeviceId?: string
): Promise<boolean> {
  const run = runs.get(runId)
  if (!run) return false
  if (run.deviceId && callerDeviceId !== run.deviceId) return false
  run.cancel?.()
  await settle(run, "cancelled")
  return true
}

/** Runs currently streaming, for status surfaces and tests. */
export function activeRemoteExternalRuns(): Array<{
  runId: string
  chatSessionId: string
  agentId: string
  seq: number
}> {
  return [...runs.values()].map(({ runId, chatSessionId, agentId, seq }) => ({
    runId,
    chatSessionId,
    agentId,
    seq,
  }))
}
