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

import { z } from "zod"
import type { ExternalAgentManager } from "../../manager"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { publishHostEvent } from "@/lib/companion/host-event-publisher"
import type {
  AcpConfigOption,
  AcpElicitationResponse,
  AcpPermissionOption,
  AcpPermissionResponse,
  ExternalAgentCogniaModelBinding,
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentImageContent,
  ExternalAgentImageWithheldReason,
} from "@/types/agent/external-agent"
import type { ExternalAgentConfigStamp } from "@/types/agent/external-agent-config-store"
import type { ApprovalDecision } from "@cognia/agent-config-types"

import { mountHostConfigAgent, resetHostConfigMountsForTests } from "../../config/host-config-mount"
import { admitExternalAgentRun, releaseExternalAgentRun } from "../../policy/run-admission"
import type { RunAdmissionRefusal } from "../../policy/run-admission"
import { pickPermissionOptionId } from "../../session/chat-decision-bridge"
import {
  reportableConfigOptions,
  type ExternalAgentModelSurface,
  type ExternalAgentThinkingSurface,
} from "../../session/session-models"

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
  /**
   * Model id this turn runs on, chosen from the configuration's own catalog.
   *
   * The host-owned lane had no model axis at all, so a conversation bound to a
   * host configuration ran on whatever the agent defaults to no matter what
   * the composer's picker said. The local lane has passed this to
   * `manager.execute` since it existed, and this is the same value reaching
   * the same call from the other side of the wire.
   */
  model?: string
  /** Thinking level for this turn, in the app's vocabulary (`low` to `max`). */
  reasoningEffort?: string
  systemPrompt?: string
  allowedTools?: string[]
  /** Resume an agent session this run already created. */
  externalSessionId?: string
  /**
   * The Cognia provider/model this turn runs on through the Host's gateway,
   * resolved against the Host's own settings and vault (ADR-0090,
   * 2026-10-02). Three states, kept distinct all the way to the manager:
   * absent inherits the Host configuration's own setting, `null` selects the
   * agent's native model configuration, and a binding selects Cognia.
   */
  cogniaModel?: ExternalAgentCogniaModelBinding | null
  /**
   * The authenticated caller, injected host-side by the RPC layer. Recorded so
   * a decision can only be answered by the device that was shown the question.
   */
  callerDeviceId?: string
  /**
   * The turn's images, staged on this Host through the chunked upload plane,
   * in turn order. Item `i` was staged under {@link remoteRunAttachmentScope}
   * `(runId, i)`, so a ref staged for any other run or position resolves to
   * nothing. What the agent cannot see is reported on the run's stream.
   */
  attachments?: RemoteRunAttachment[]
}

/**
 * Most images one run takes. Above any turn the composer can build (six
 * attachments, at most twelve sampled frames each), and small enough that the
 * refs fit the run-turn request with room to spare.
 */
export const REMOTE_RUN_MAX_ATTACHMENTS = 96

/**
 * `attachments` off the wire, or a refusal naming the field. Every item names
 * a ref, a file name and a media type, and nothing else rides along.
 */
export function parseRemoteRunAttachments(value: unknown): RemoteRunAttachment[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > REMOTE_RUN_MAX_ATTACHMENTS) {
    throw new Error(
      `external_agent_run_turn.attachments must be an array of at most ${REMOTE_RUN_MAX_ATTACHMENTS} items`
    )
  }
  return value.map((item, index) => {
    const entry = item as Partial<Record<keyof RemoteRunAttachment, unknown>> | null
    if (
      !entry ||
      typeof entry !== "object" ||
      Object.keys(entry).some((key) => key !== "ref" && key !== "name" && key !== "mediaType") ||
      typeof entry.ref !== "string" ||
      !entry.ref ||
      typeof entry.name !== "string" ||
      typeof entry.mediaType !== "string"
    ) {
      throw new Error(
        `external_agent_run_turn.attachments[${index}] must be { ref, name, mediaType }`
      )
    }
    return { ref: entry.ref, name: entry.name, mediaType: entry.mediaType }
  })
}

/** One staged image of a run, as the client names it. */
export interface RemoteRunAttachment {
  ref: string
  name: string
  mediaType: string
}

/**
 * Why a run's images did not reach the Host's agent: the agent's own verdict
 * (`agent`, `model`), or `upload` when a staged ref no longer resolves (the
 * staging expired, or it was not staged for this run).
 */
export interface RemoteAttachmentsWithheldFrame {
  reason: ExternalAgentImageWithheldReason | "upload"
  count: number
  model?: string
}

/**
 * The upload scope image `index` of run `runId` is staged under.
 *
 * One scope per image rather than the chat session: the Host stages at most
 * six unconsumed uploads per scope and device, and a turn can carry more
 * frames than that from one sampled video. Derived from the run, so the Host
 * accepts only refs staged for exactly this turn.
 */
export function remoteRunAttachmentScope(runId: string, index: number): string {
  return `external-run:${runId}:${index}`
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
  operationResult?: { requestId: string; value?: unknown; error?: string }
  /** Set on the single frame that ends the run. */
  terminal?: "completed" | "failed" | "cancelled"
  /** Present on `failed`. Never carries a stack or a host path. */
  error?: string
  /**
   * Set on the one frame that reports which of the run's images the agent was
   * not handed. Like `operationResult`, its `event` is only a carrier.
   */
  attachmentsWithheld?: RemoteAttachmentsWithheldFrame
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
  reply?: (response: AcpPermissionResponse) => void
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
  /** The turn was asked to run on a Cognia model (a gateway task). */
  cogniaBound: boolean
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

export interface RemoteRunDeps {
  admit: typeof admitExternalAgentRun
  release: typeof releaseExternalAgentRun
  publish: (topic: string, payload: unknown) => Promise<void>
  getManager: () => Promise<ExternalRunManager>
  now: () => number
  /**
   * The run's staged images as prompt content, or `null` when any of them no
   * longer resolves for this run and caller (or is not a portable image).
   */
  loadAttachments: (
    runId: string,
    attachments: readonly RemoteRunAttachment[],
    callerDeviceId: string | undefined
  ) => Promise<ExternalAgentImageContent[] | null>
  /** Spend the run's refs once the turn is over, freeing their bytes. */
  consumeAttachments: (refs: readonly string[]) => Promise<void>
}

/** The slice of `ExternalAgentManager` this module uses. */
export interface ExternalRunManager extends Partial<
  Pick<
    ExternalAgentManager,
    | "getSession"
    | "getSessionOperationCapabilities"
    | "refreshSessionCommands"
    | "executeSessionCommand"
    | "enqueueSessionInput"
    | "clearSessionInputQueue"
    | "setSessionQueuePolicy"
    | "setSessionRuntimeControls"
    | "getSessionRuntimeState"
    | "abortSessionRetry"
    | "getSessionEntries"
    | "getSessionTree"
    | "forkSession"
    | "cloneSession"
    | "renameSession"
    | "archiveSession"
    | "unarchiveSession"
    | "exportSessionHtml"
    | "executeSessionShell"
    | "abortSessionShell"
    | "cancel"
    | "steerSession"
    | "addEventListener"
  >
> {
  getAgent(agentId: string): unknown | undefined
  addAgent(config: ExternalAgentConfig, options?: { connect?: boolean }): Promise<unknown>
  removeAgent(agentId: string): Promise<void>
  /** {@link ExternalAgentManager.resolvePromptAttachments}; absent on a stub that takes no images. */
  resolvePromptAttachments?: ExternalAgentManager["resolvePromptAttachments"]
  execute(
    agentId: string,
    prompt: string,
    options?: {
      sessionId?: string
      model?: string
      attachments?: ExternalAgentImageContent[]
      reasoningEffort?: string
      systemPrompt?: string
      allowedTools?: string[]
      cogniaModel?: ExternalAgentCogniaModelBinding | null
      context?: { custom: { chatSessionId: string; callerDeviceId?: string } }
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
  /**
   * What the session's agent offers on its model and thinking axes. Optional
   * so a manager without it simply reports nothing, which the client renders
   * as "the models arrive with a turn" rather than as a failure.
   */
  fetchSessionModelSurface?(
    agentId: string,
    sessionId: string
  ): Promise<
    | {
        status: "ok"
        data: { models: ExternalAgentModelSurface; thinking: ExternalAgentThinkingSurface }
      }
    | { status: "unsupported" }
    | { status: "error"; error: Error }
  >
  /** The session's raw config options, when the adapter keeps them synchronously. */
  getConfigOptions?(
    agentId: string,
    sessionId: string
  ):
    | { status: "ok"; data: AcpConfigOption[] }
    | { status: "unsupported" }
    | { status: "error"; error: Error }
}

const defaultDeps: RemoteRunDeps = {
  admit: admitExternalAgentRun,
  release: releaseExternalAgentRun,
  publish: publishHostEvent,
  getManager: async () => {
    const { getExternalAgentManager } = await import("../../manager")
    return getExternalAgentManager() as unknown as ExternalRunManager
  },
  now: () => Date.now(),
  loadAttachments: async (runId, attachments, callerDeviceId) => {
    const [{ resolveAttachmentRef }, { bytesToBase64, isPortableImageType }] = await Promise.all([
      import("@/lib/db/session-attachment-uploads"),
      import("@/lib/ocr/image-prep"),
    ])
    const images: ExternalAgentImageContent[] = []
    for (const [index, attachment] of attachments.entries()) {
      const row = await resolveAttachmentRef(attachment.ref, {
        sessionId: remoteRunAttachmentScope(runId, index),
        ...(callerDeviceId ? { deviceId: callerDeviceId } : {}),
      })
      // The media type the Host sniffed at commit, not the one the client
      // declared: only bytes that really are a portable image go to an agent.
      if (!row?.bytes || !isPortableImageType(row.mediaType)) return null
      images.push({
        type: "image",
        source: { type: "base64", data: bytesToBase64(row.bytes), mediaType: row.mediaType },
      })
    }
    return images
  },
  consumeAttachments: async (refs) => {
    const { consumeAttachmentRefs } = await import("@/lib/db/session-attachment-uploads")
    await consumeAttachmentRefs(refs)
  },
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
  for (const watch of sessionWatches.values()) {
    clearTimeout(watch.timer)
    watch.unsubscribe()
  }
  sessionWatches.clear()
  for (const owner of sessionOwners.values()) {
    owner.unsubscribe?.()
    if (owner.timer) clearTimeout(owner.timer)
  }
  sessionOwners.clear()
  runs.clear()
  decisions.clear()
  resetHostConfigMountsForTests()
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
  error?: string,
  operationResult?: RemoteRunFrame["operationResult"],
  attachmentsWithheld?: RemoteRunFrame["attachmentsWithheld"]
): Promise<void> {
  run.seq += 1
  const frame: RemoteRunFrame = {
    runId: run.runId,
    chatSessionId: run.chatSessionId,
    seq: run.seq,
    event,
    ...(terminal ? { terminal } : {}),
    ...(error ? { error } : {}),
    ...(operationResult ? { operationResult } : {}),
    ...(attachmentsWithheld ? { attachmentsWithheld } : {}),
  }
  const published = run.publishing.then(() => deps.publish(EXTERNAL_RUN_EVENT_TOPIC, frame))
  run.publishing = published.catch(() => undefined)
  return published
}

/**
 * How long the end of a turn waits for the session's model report. ACP answers
 * from the session it already holds; Pi asks its process, which is the one
 * that can be slow. The terminal frame must not wait on it for longer.
 */
export const MODEL_REPORT_TIMEOUT_MS = 5_000

/**
 * Tell the client which models the session it just ran on offers.
 *
 * A paired client has no handle on the Host's agent session, so without this
 * its model picker had two options: spawn a second copy of the agent on the
 * Host to ask (which it did, under the same process id as the running copy),
 * or show nothing. The run stream is already the one channel between the two,
 * so the session's options ride it as the `config_options_update` an ACP
 * agent would have pushed itself. Sent after the turn, because that is when the
 * model this conversation asked for (`applyModelToSession`) has been applied.
 *
 * Best-effort by construction: a failure to read costs the client its list
 * until the next turn, never the turn's terminal frame.
 */
async function reportSessionModels(run: ActiveRun, manager: ExternalRunManager): Promise<void> {
  const sessionId = run.externalSessionId
  if (!sessionId || run.settled || !manager.fetchSessionModelSurface) return
  // A gateway task's child is released when the turn ends, and what it would
  // report is the task's own `cognia/<model>` route — not the agent's native
  // models. Sending that would teach the client's picker a list the agent does
  // not have, so a Cognia-bound turn reports nothing.
  if (run.cogniaBound || isGatewayTaskSessionId(sessionId)) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const surface = await Promise.race([
      manager.fetchSessionModelSurface(run.agentId, sessionId),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), MODEL_REPORT_TIMEOUT_MS)
      }),
    ])
    if (!surface || surface.status !== "ok" || run.settled) return
    const raw = manager.getConfigOptions?.(run.agentId, sessionId)
    const configOptions = reportableConfigOptions(
      raw?.status === "ok" ? raw.data : undefined,
      surface.data
    )
    if (configOptions.length === 0) return
    await emit(run, {
      type: "config_options_update",
      sessionId,
      timestamp: new Date(deps.now()),
      configOptions,
    } as ExternalAgentEvent)
  } catch {
    // See the docstring: the report is never worth a turn.
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Gateway task sessions (`gatewaySessionId` in `config/gateway-task`). */
const GATEWAY_SESSION_PREFIX = "cognia-gateway:"

function isGatewayTaskSessionId(sessionId: string | undefined): boolean {
  return !!sessionId && sessionId.startsWith(GATEWAY_SESSION_PREFIX)
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
      const response = {
        requestId: decision.responseRequestId,
        granted: false,
        optionId: pickPermissionOptionId("deny", decision.options),
      }
      if (decision.reply) decision.reply(response)
      else await manager.respondToPermission(decision.agentId, decision.externalSessionId, response)
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
    const response: AcpPermissionResponse = {
      requestId: held.responseRequestId,
      granted: decision !== "deny",
      ...(decision === "allow_always" ? { rememberChoice: true, scope: "session" as const } : {}),
      optionId: pickPermissionOptionId(decision, held.options),
    }
    if (held.reply) held.reply(response)
    else await manager.respondToPermission(held.agentId, held.externalSessionId, response)
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
/**
 * The run's staged images this Host's agent can see, after telling the client
 * about the rest.
 *
 * Decided here, inside the run, rather than before `started` is answered: the
 * verdict can need the agent's handshake (ACP negotiates image input), and
 * spawning an agent inside the start RPC would hold the client's request open
 * for as long as a cold start takes.
 */
async function deliverableRunImages(
  run: ActiveRun,
  manager: ExternalRunManager,
  request: RemoteRunRequest,
  staged: readonly RemoteRunAttachment[]
): Promise<ExternalAgentImageContent[]> {
  if (staged.length === 0) return []
  const withheld = (frame: RemoteAttachmentsWithheldFrame) =>
    emit(
      run,
      { type: "progress", timestamp: new Date(deps.now()), message: "", progress: 0 },
      undefined,
      undefined,
      undefined,
      frame
    ).catch(() => undefined)
  const images = await deps.loadAttachments(request.runId, staged, request.callerDeviceId)
  if (!images) {
    await withheld({ reason: "upload", count: staged.length })
    return []
  }
  if (!manager.resolvePromptAttachments) return images
  const verdict = await manager.resolvePromptAttachments(run.agentId, images, {
    ...(request.externalSessionId ? { sessionId: request.externalSessionId } : {}),
    ...(request.model ? { model: request.model } : {}),
    ...(request.cogniaModel !== undefined ? { cogniaModel: request.cogniaModel } : {}),
  })
  if (verdict.withheld) await withheld(verdict.withheld)
  return verdict.delivered
}

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
    agentId = await mountHostConfigAgent(
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
    cogniaBound: !!request.cogniaModel,
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
  const staged = request.attachments ?? []
  void (async () => {
    try {
      if (request.externalSessionId && !isGatewayTaskSessionId(request.externalSessionId))
        assertSessionOwner(
          agentId,
          request.externalSessionId,
          request.chatSessionId,
          request.callerDeviceId
        )
      const images = await deliverableRunImages(run, manager, request, staged)
      const result = await manager.execute(agentId, request.prompt, {
        sessionId: request.externalSessionId,
        ...(images.length > 0 ? { attachments: images } : {}),
        // Omitted rather than passed as undefined so the manager's own
        // `if (options?.model)` gate reads the same on both lanes: an absent
        // model means "inherit the agent's own selection", and writing an
        // empty one would switch a session onto nothing.
        ...(request.model ? { model: request.model } : {}),
        ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
        ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
        ...(request.allowedTools !== undefined ? { allowedTools: request.allowedTools } : {}),
        // `!== undefined`, not truthiness: `null` is the explicit "native"
        // instruction and must reach the manager, while an absent key leaves
        // the Host configuration's own binding in force.
        ...(request.cogniaModel !== undefined ? { cogniaModel: request.cogniaModel } : {}),
        // The device that asked. A gateway task started for it is bound to it,
        // so a different device cannot resume or rebind the same task.
        context: {
          custom: {
            chatSessionId: request.chatSessionId,
            ...(request.callerDeviceId ? { callerDeviceId: request.callerDeviceId } : {}),
          },
        },
        signal: controller.signal,
        onEvent: (event) => {
          if (run.settled) return
          if (event.sessionId) {
            run.externalSessionId = event.sessionId
            bindSessionOwner(manager, agentId, event.sessionId, {
              chatSessionId: request.chatSessionId,
              deviceId: request.callerDeviceId,
              revision: request.stamp.revision,
            })
          }
          if (event.type === "permission_request" || event.type === "elicitation_request") {
            registerDecision(run, event)
          }
          // A dropped frame is a hole the client can see (its `seq` gap) and
          // recover from; a crashed host is neither.
          void emit(run, event).catch(() => undefined)
        },
      })
      const completedSessionId = (result as { sessionId?: string } | null)?.sessionId
      if (completedSessionId) {
        run.externalSessionId = completedSessionId
        bindSessionOwner(manager, agentId, completedSessionId, {
          chatSessionId: request.chatSessionId,
          deviceId: request.callerDeviceId,
          revision: request.stamp.revision,
        })
      }
      await reportSessionModels(run, manager)
      await settle(run, "completed")
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      // A refused model fails the turn after the session opened, and is the
      // moment the client most needs the list the agent actually has.
      if (!controller.signal.aborted) await reportSessionModels(run, manager)
      await settle(run, controller.signal.aborted ? "cancelled" : "failed", message)
    } finally {
      // Spent whether the turn ran, failed or was refused: the bytes were
      // staged for this run alone, and a resend stages its own.
      if (staged.length > 0) {
        await deps.consumeAttachments(staged.map((attachment) => attachment.ref)).catch(() => {})
      }
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

// Session operations reuse the run admission and decision channels. Native IDs
// alone never confer authority over another paired device's conversation.
interface SessionOwner {
  chatSessionId: string
  deviceId?: string
  revision: string
  pending?: ExternalAgentEvent[]
  unsubscribe?: () => void
  timer?: ReturnType<typeof setTimeout>
}
const sessionOwners = new Map<string, SessionOwner>()
function bindSessionOwner(
  manager: ExternalRunManager,
  agentId: string,
  sessionId: string,
  identity: SessionOwner
) {
  const key = `${agentId}:${sessionId}`
  const existing = sessionOwners.get(key)
  if (existing) return
  const owner: SessionOwner = {
    chatSessionId: identity.chatSessionId,
    deviceId: identity.deviceId,
    revision: identity.revision,
    pending: [],
  }
  sessionOwners.set(key, owner)
  // Bridge the brief native-session creation -> browser watch admission gap.
  // Once attached, the existing companion event bus owns replay and ordering.
  owner.unsubscribe = manager.addEventListener?.(agentId, (event) => {
    if (event.sessionId !== sessionId || event.delivery !== "out_of_band") return
    if (
      [...sessionWatches.values()].some(
        (watch) =>
          watch.run.agentId === agentId &&
          watch.run.externalSessionId === sessionId &&
          watch.purpose === "transcript"
      )
    )
      return
    if (owner.pending!.length >= 256) {
      owner.pending = [
        {
          type: "error",
          timestamp: new Date(deps.now()),
          sessionId,
          delivery: "out_of_band",
          error: "Remote session events exceeded the handoff buffer",
          code: "REMOTE_SESSION_GAP",
          recoverable: true,
        } as ExternalAgentEvent,
      ]
      void manager.cancel?.(agentId, sessionId).catch(() => undefined)
      return
    }
    owner.pending!.push(event)
  })
  owner.timer = setTimeout(() => {
    owner.unsubscribe?.()
    owner.unsubscribe = undefined
    owner.pending = []
  }, SESSION_WATCH_TTL_MS)
  ;(owner.timer as { unref?: () => void }).unref?.()
}
const sessionWatches = new Map<
  string,
  {
    run: ActiveRun
    unsubscribe: () => void
    timer: ReturnType<typeof setTimeout>
    stopShell?: () => Promise<void>
    purpose: "transcript" | "presentation" | "shell"
  }
>()
const SESSION_WATCH_TTL_MS = 180_000
const forkTargetSchema = z
  .object({
    kind: z.enum(["entry", "turn"]),
    id: z.string().min(1),
    boundary: z.enum(["before", "through"]),
  })
  .strict()
const sessionOperationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("watch"),
      watchId: z.string().min(1),
      purpose: z.enum(["transcript", "presentation", "shell"]).optional(),
    })
    .strict(),
  z.object({ operation: z.literal("unwatch"), watchId: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("rename"), name: z.string().trim().min(1) }).strict(),
  z.object({ operation: z.literal("steer"), text: z.string().min(1) }).strict(),
  z.object({ operation: z.literal("commandExecution"), command: z.string().min(1) }).strict(),
  z
    .object({
      operation: z.enum([
        "capabilities",
        "snapshot",
        "commands",
        "runtimeState",
        "entries",
        "tree",
        "exportHtml",
        "clearQueue",
        "abortRetry",
        "archive",
        "unarchive",
        "abortShell",
        "cancel",
      ]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("inputQueue"),
      input: z
        .object({
          text: z.string(),
          images: z
            .array(
              z
                .object({
                  data: z.string().max(14_000_000),
                  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
                })
                .strict()
            )
            .max(20)
            .optional(),
        })
        .strict(),
      mode: z.enum(["steer", "follow_up"]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("queuePolicy"),
      policy: z
        .object({
          steering: z.enum(["all", "one-at-a-time"]).optional(),
          followUp: z.enum(["all", "one-at-a-time"]).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("runtimeControls"),
      controls: z
        .object({ autoCompaction: z.boolean().optional(), autoRetry: z.boolean().optional() })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("fork"),
      forkAt: forkTargetSchema.optional(),
      forkAtEntryId: z.string().min(1).optional(),
    })
    .strict(),
  z.object({ operation: z.literal("clone") }).strict(),
  z
    .object({
      operation: z.literal("shell"),
      command: z.string().min(1),
      excludeFromContext: z.boolean().optional(),
      watchId: z.string().min(1),
    })
    .strict(),
])
export type RemoteSessionOperation = z.infer<typeof sessionOperationSchema>
export interface RemoteSessionTarget {
  stamp: ExternalAgentConfigStamp
  chatSessionId: string
  externalSessionId: string
}
export interface RemoteSessionRequest extends RemoteSessionTarget {
  requestId: string
  action: RemoteSessionOperation
  callerDeviceId?: string
}
export const REMOTE_SESSION_READS = new Set<RemoteSessionOperation["operation"]>([
  "capabilities",
  "snapshot",
  "commands",
  "runtimeState",
  "entries",
  "tree",
  "watch",
  "unwatch",
])

function assertSessionOwner(
  agentId: string,
  sessionId: string,
  chatSessionId: string,
  callerDeviceId?: string
) {
  const owner = sessionOwners.get(`${agentId}:${sessionId}`)
  if (!owner || owner.chatSessionId !== chatSessionId || owner.deviceId !== callerDeviceId)
    throw new Error("External session does not belong to this caller and conversation")
  return owner
}

async function closeSessionWatch(id: string) {
  const watch = sessionWatches.get(id)
  if (!watch) return
  sessionWatches.delete(id)
  clearTimeout(watch.timer)
  watch.unsubscribe()
  await watch.stopShell?.().catch(() => undefined)
  for (const [decisionId, decision] of decisions)
    if (decision.runId === id) await expireDecision(decisionId)
  watch.run.settled = true
  await deps.release(id)
}

export async function executeRemoteSessionOperation(
  request: RemoteSessionRequest,
  readOnly: boolean
): Promise<{ value: unknown }> {
  const action = sessionOperationSchema.parse(request.action)
  if (readOnly && !REMOTE_SESSION_READS.has(action.operation))
    throw new Error("Session mutation requires interactive authorization")
  const owner = assertSessionOwner(
    request.stamp.configId,
    request.externalSessionId,
    request.chatSessionId,
    request.callerDeviceId
  )
  if (owner.revision !== request.stamp.revision)
    throw new Error("External session belongs to a different configuration revision")
  if (
    (action.operation === "commandExecution" && !hasNoLeakingPiiDeep(action.command)) ||
    (action.operation === "inputQueue" && !hasNoLeakingPiiDeep(action.input)) ||
    (action.operation === "steer" && !hasNoLeakingPiiDeep(action.text))
  )
    throw new Error("External input rejected by the PII gate")
  if (action.operation === "unwatch") {
    const watch = sessionWatches.get(action.watchId)
    if (
      watch &&
      (watch.run.deviceId !== request.callerDeviceId ||
        watch.run.externalSessionId !== request.externalSessionId ||
        watch.run.agentId !== request.stamp.configId)
    )
      throw new Error("Session watch does not belong to this caller")
    await closeSessionWatch(action.watchId)
    return { value: null }
  }
  const admission = await deps.admit(request.requestId, request.stamp)
  if (!admission.ok) throw new Error("External agent configuration is not currently admitted")
  let retainLease = false
  try {
    const manager = await deps.getManager()
    const id = request.stamp.configId
    const sid = request.externalSessionId
    if (!manager.getSession?.(id, sid)) throw new Error("External session is no longer available")
    const call = async (name: keyof ExternalRunManager, ...args: unknown[]) => {
      const method = manager[name]
      if (typeof method !== "function")
        throw new Error(`Host does not support session operation ${action.operation}`)
      return (method as (...values: unknown[]) => Promise<unknown>).apply(manager, [
        id,
        sid,
        ...args,
      ])
    }
    let value: unknown
    switch (action.operation) {
      case "capabilities":
        value = await call("getSessionOperationCapabilities")
        break
      case "snapshot":
        value = manager.getSession(id, sid)
        break
      case "commands":
        value = await call("refreshSessionCommands")
        break
      case "runtimeState":
        value = await call("getSessionRuntimeState")
        break
      case "entries":
        value = await call("getSessionEntries")
        break
      case "tree":
        value = await call("getSessionTree")
        break
      case "clearQueue":
        value = await call("clearSessionInputQueue")
        break
      case "abortRetry":
        value = await call("abortSessionRetry")
        break
      case "rename":
        value = await call("renameSession", action.name)
        break
      case "archive":
        value = await call("archiveSession")
        break
      case "unarchive":
        value = await call("unarchiveSession")
        break
      case "exportHtml":
        value = await call("exportSessionHtml")
        break
      case "abortShell":
        value = await call("abortSessionShell")
        break
      case "cancel":
        value = await call("cancel")
        break
      case "steer":
        value = await call("steerSession", action.text)
        break
      case "commandExecution":
        value = await call("executeSessionCommand", action.command)
        break
      case "inputQueue":
        value = await call("enqueueSessionInput", action.input, action.mode)
        break
      case "queuePolicy":
        value = await call("setSessionQueuePolicy", action.policy)
        break
      case "runtimeControls":
        value = await call("setSessionRuntimeControls", action.controls)
        break
      case "fork":
      case "clone": {
        value = await call(
          action.operation === "fork" ? "forkSession" : "cloneSession",
          action.operation === "fork"
            ? { forkAt: action.forkAt, forkAtEntryId: action.forkAtEntryId }
            : undefined
        )
        const newId = (value as { id?: string })?.id
        if (newId) bindSessionOwner(manager, id, newId, owner)
        break
      }
      case "watch": {
        const previous = sessionWatches.get(action.watchId)
        if (previous) {
          if (
            previous.run.deviceId !== request.callerDeviceId ||
            previous.run.externalSessionId !== sid ||
            previous.run.agentId !== id
          )
            throw new Error("Session watch does not belong to this caller")
          clearTimeout(previous.timer)
          previous.timer = setTimeout(() => {
            void closeSessionWatch(action.watchId).catch(() => undefined)
          }, SESSION_WATCH_TTL_MS)
          ;(previous.timer as { unref?: () => void }).unref?.()
        } else {
          if (!manager.addEventListener)
            throw new Error("Host does not support session event subscriptions")
          if (action.watchId !== request.requestId || runs.has(action.watchId))
            throw new Error("Invalid session watch identity")
          const run: ActiveRun = {
            runId: action.watchId,
            chatSessionId: request.chatSessionId,
            agentId: id,
            revision: request.stamp.revision,
            deviceId: request.callerDeviceId,
            seq: 0,
            settled: false,
            externalSessionId: sid,
            cogniaBound: false,
            publishing: Promise.resolve(),
          }
          const purpose = action.purpose ?? "transcript"
          const unsubscribe = manager.addEventListener(id, (event) => {
            if (purpose === "shell") return
            if (
              purpose === "presentation" &&
              ![
                "commands_update",
                "session_info_update",
                "extension_ui_update",
                "plan_update",
                "config_options_update",
              ].includes(event.type)
            )
              return
            if (event.sessionId !== sid || run.settled) return
            if (
              event.delivery !== "out_of_band" &&
              !["session_info_update", "input_queue_cleared", "commands_update"].includes(
                event.type
              )
            )
              return
            if (event.type === "permission_request" || event.type === "elicitation_request")
              registerDecision(run, event)
            void emit(run, event).catch(() => undefined)
          })
          const timer = setTimeout(() => {
            void closeSessionWatch(action.watchId).catch(() => undefined)
          }, SESSION_WATCH_TTL_MS)
          ;(timer as { unref?: () => void }).unref?.()
          sessionWatches.set(action.watchId, { run, unsubscribe, timer, purpose })
          retainLease = true
          for (const event of purpose === "transcript" ? (owner.pending?.splice(0) ?? []) : []) {
            if (event.type === "permission_request" || event.type === "elicitation_request")
              registerDecision(run, event)
            await emit(run, event)
          }
        }
        value = { watchId: action.watchId, session: manager.getSession(id, sid) }
        break
      }
      case "shell": {
        const watch = sessionWatches.get(action.watchId)
        if (
          !watch ||
          watch.run.deviceId !== request.callerDeviceId ||
          watch.run.externalSessionId !== sid ||
          watch.run.agentId !== id ||
          watch.purpose !== "shell"
        )
          throw new Error("A live session watch is required for native shell approval")
        const execution = call("executeSessionShell", action.command, {
          excludeFromContext: action.excludeFromContext,
          onPermissionRequest: (
            permission: import("@/types/agent/external-agent").AcpPermissionRequest
          ) =>
            new Promise<AcpPermissionResponse>((resolve) => {
              const event: ExternalAgentEvent = {
                type: "permission_request",
                request: permission,
                sessionId: sid,
                timestamp: new Date(deps.now()),
                delivery: "out_of_band",
              }
              registerDecision(watch.run, event)
              const decision = decisions.get(
                remoteDecisionId(watch.run.runId, permission.requestId ?? permission.id)
              )
              if (!decision) {
                resolve({ requestId: permission.requestId ?? permission.id, granted: false })
                return
              }
              decision.reply = resolve
              void emit(watch.run, event).catch(() => {
                void expireDecision(
                  remoteDecisionId(watch.run.runId, permission.requestId ?? permission.id)
                )
              })
            }),
        })
        retainLease = true
        watch.stopShell = async () => {
          await call("abortSessionShell")
        }
        void execution
          .then(
            (result) =>
              emit(
                watch.run,
                {
                  type: "progress",
                  timestamp: new Date(deps.now()),
                  sessionId: sid,
                  message: "",
                  progress: 100,
                },
                undefined,
                undefined,
                { requestId: request.requestId, value: result }
              ),
            (error) =>
              emit(
                watch.run,
                {
                  type: "progress",
                  timestamp: new Date(deps.now()),
                  sessionId: sid,
                  message: "",
                  progress: 100,
                },
                undefined,
                undefined,
                {
                  requestId: request.requestId,
                  error: error instanceof Error ? error.message : String(error),
                }
              )
          )
          .catch(() => undefined)
          .finally(async () => {
            watch.stopShell = undefined
            await deps.release(request.requestId)
          })
          .catch(() => undefined)
        value = { started: true }

        break
      }
    }
    return { value: value ?? null }
  } finally {
    if (!retainLease) await deps.release(request.requestId)
  }
}
