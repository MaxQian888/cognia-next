/**
 * The client half of a host-driven external agent run.
 *
 * The turn does not come back through the RPC that started it. It arrives as
 * frames on `external-agent://session-event`, which rides the companion event
 * bus — so reconnects, replay and ordering are the bus's problem, already
 * solved, and this module only has to do the part the bus cannot: decide which
 * frames belong to THIS run and which of them it has already applied.
 *
 * Dedup is by the frame's per-run `seq` rather than by the bus cursor. The bus
 * cursor is global across every topic a client subscribes to, so after a replay
 * a client cannot tell from it whether a given external-agent frame is new.
 * The per-run sequence can answer that, and it also makes a *gap* visible —
 * which matters, because silently rendering a turn with a hole in it looks
 * exactly like a turn that went quiet.
 */

import { getActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import type { ExternalAgentManager } from "../../manager"
import type { RemoteSessionTarget, RemoteSessionOperation } from "./remote-run-service"
import { transport } from "@/lib/tauri"
import type {
  AcpElicitationResponse,
  ExternalAgentCogniaModelBinding,
  ExternalAgentEvent,
  ExternalAgentImageContent,
} from "@/types/agent/external-agent"
import type { ApprovalDecision } from "@cognia/agent-config-types"
import type { ExternalAgentConfigStamp } from "@/types/agent/external-agent-config-store"

import type { RunAdmissionRefusal } from "../../policy/run-admission"
import {
  EXTERNAL_RUN_EVENT_TOPIC,
  REMOTE_RUN_MAX_ATTACHMENTS,
  remoteRunAttachmentScope,
  type RemoteAttachmentsWithheldFrame,
  type RemoteRunAttachment,
  type RemoteRunFrame,
} from "./remote-run-service"
import {
  HOST_CONFIG_COMMANDS,
  callApprovedHostConfigCommand,
  callHostConfigCommand,
} from "./remote-host-configs"

export { EXTERNAL_RUN_EVENT_TOPIC }
export type { RemoteAttachmentsWithheldFrame, RemoteRunAttachment, RemoteRunFrame }

/**
 * Named from the shared table rather than re-spelled, so the run plane and the
 * configuration plane cannot drift on a command name — and so every call below
 * goes through `callHostConfigCommand`, which checks the host handshake for
 * this operation before it reaches the transport. Calling `transport.call`
 * directly would answer a host too old to run turns with an "unknown command"
 * instead of the structured "this host does not support it" every sibling
 * operation gives.
 */
export const REMOTE_RUN_COMMANDS = Object.freeze({
  run: HOST_CONFIG_COMMANDS.run,
  cancel: HOST_CONFIG_COMMANDS.cancel,
  resolve: HOST_CONFIG_COMMANDS.resolve,
} as const)

export type RemoteTurnStart =
  | { started: true; runId: string; agentId: string }
  | { started: false; refusal: RunAdmissionRefusal }

export interface RemoteRunSubscription {
  onEvent: (event: ExternalAgentEvent, frame: RemoteRunFrame) => void
  onOperationResult?: (result: NonNullable<RemoteRunFrame["operationResult"]>) => void
  /** Which of the run's images the Host's agent was not handed, and why. */
  onAttachmentsWithheld?: (withheld: RemoteAttachmentsWithheldFrame) => void
  /** Called once, with how the run ended. */
  onTerminal: (terminal: NonNullable<RemoteRunFrame["terminal"]>, error: string | undefined) => void
  /**
   * A frame arrived out of order and the ones between were never seen.
   *
   * Reported rather than papered over: the client that owns the transcript is
   * the only thing that can decide whether to re-read or to mark the turn
   * incomplete, and rendering the later frame as if nothing were missing is the
   * one option that is always wrong.
   */
  onGap?: (expected: number, received: number) => void
}

/**
 * Watch one run. Returns an unsubscribe function.
 *
 * Subscribe BEFORE starting the turn: the host begins streaming the moment it
 * accepts, and a subscription opened afterwards would miss the opening frames.
 */
export function subscribeRemoteExternalRun(
  runId: string,
  handlers: RemoteRunSubscription
): () => void {
  let lastSeq = 0
  let settled = false

  return transport.subscribe<RemoteRunFrame>(EXTERNAL_RUN_EVENT_TOPIC, (frame) => {
    if (!frame || frame.runId !== runId) return
    // A terminal frame is authoritative and singular. Anything after it is a
    // replay of a run this client has already finished rendering.
    if (settled) return
    if (frame.seq <= lastSeq) return
    if (frame.seq > lastSeq + 1) handlers.onGap?.(lastSeq + 1, frame.seq)
    lastSeq = frame.seq

    if (frame.operationResult) handlers.onOperationResult?.(frame.operationResult)
    else if (frame.attachmentsWithheld) handlers.onAttachmentsWithheld?.(frame.attachmentsWithheld)
    else handlers.onEvent(frame.event, frame)
    if (frame.terminal) {
      settled = true
      handlers.onTerminal(frame.terminal, frame.error)
    }
  })
}

/**
 * Resolve once the host has acknowledged our subscription to the run topic.
 *
 * `external-agent://session-event` is `default_on: false` on the companion
 * plane: the host delivers nothing on it until it has acknowledged a
 * `subscribe` control frame, and that frame is dropped while the socket is
 * still opening. `subscribeRemoteExternalRun` is synchronous, so a caller that
 * subscribed and immediately started the turn could lose the opening frames
 * (reported as a gap) or, on a cold socket, the terminal frame too, in which
 * case the turn never settled. Transports without the control frame (Tauri,
 * the CLI stdio bridge) resolve immediately.
 */
export async function whenRemoteRunChannelSubscribed(): Promise<void> {
  const ready = (transport as { whenSubscribed?: (channels: readonly string[]) => Promise<void> })
    .whenSubscribed
  if (typeof ready === "function") await ready.call(transport, [EXTERNAL_RUN_EVENT_TOPIC])
}

/** The three binding fields by name, so nothing else on the object rides along. */
function copyBinding(
  binding: ExternalAgentCogniaModelBinding | null
): ExternalAgentCogniaModelBinding | null {
  if (binding === null) return null
  return {
    providerId: binding.providerId,
    modelId: binding.modelId,
    ...(binding.accountId !== undefined ? { accountId: binding.accountId } : {}),
  }
}

/**
 * Stage a turn's images on the Host before the turn starts, in order.
 *
 * Each goes through the chunked upload plane (the run-turn request itself is
 * capped well under one image) under its own run-scoped upload scope, which
 * is how the Host knows a ref was staged for this run and position. Throws on
 * the first failure: a partly staged turn is not one the user sent.
 */
export async function stageRemoteRunAttachments(
  runId: string,
  images: readonly ExternalAgentImageContent[]
): Promise<RemoteRunAttachment[]> {
  const [{ uploadSessionAttachment }, { decodeDataUrl }] = await Promise.all([
    import("@/lib/companion/attachment-upload-client"),
    import("@/lib/ocr/image-prep"),
  ])
  if (images.length > REMOTE_RUN_MAX_ATTACHMENTS) {
    throw new Error(`A remote turn takes at most ${REMOTE_RUN_MAX_ATTACHMENTS} images`)
  }
  const staged: RemoteRunAttachment[] = []
  for (const [index, image] of images.entries()) {
    const { data, mediaType } = image.source
    const decoded = data ? decodeDataUrl(`data:${mediaType};base64,${data}`) : null
    if (!decoded) throw new Error("A remote turn can only stage inline image bytes")
    const extension = mediaType.split("/")[1]?.replace("jpeg", "jpg") ?? "img"
    const uploaded = await uploadSessionAttachment(remoteRunAttachmentScope(runId, index), {
      name: `image-${index + 1}.${extension}`,
      mediaType,
      bytes: decoded.bytes,
    })
    staged.push({ ref: uploaded.ref, name: uploaded.name, mediaType: uploaded.mediaType })
  }
  return staged
}

export async function startRemoteExternalTurn(input: {
  runId: string
  chatSessionId: string
  stamp: ExternalAgentConfigStamp
  prompt: string
  /**
   * The model the composer picked for this conversation.
   *
   * Sent per turn rather than stored on the configuration: the configuration
   * is shared by every conversation bound to it, and a model is a property of
   * the conversation. This is the same value the local lane hands to
   * `executeOnExternalAgent`, so the two lanes cannot disagree about what the
   * chip is promising.
   */
  model?: string
  /** The composer's thinking level, in the app's vocabulary. */
  reasoningEffort?: string
  systemPrompt?: string
  allowedTools?: string[]
  externalSessionId?: string
  /**
   * Run this turn on a Cognia provider/model through the Host's gateway, with
   * the Host's credentials (ADR-0090, 2026-10-02). Omitted inherits the Host
   * configuration's own setting; `null` explicitly selects the agent's native
   * models. Identifiers only — the Host resolves the credential.
   */
  cogniaModel?: ExternalAgentCogniaModelBinding | null
  /**
   * The turn's images, already staged on the Host
   * (`stageRemoteRunAttachments`). Only sent to a Host that advertises
   * `runTurnAttachments`; the request schema is closed against the field.
   */
  attachments?: readonly RemoteRunAttachment[]
}): Promise<RemoteTurnStart> {
  // Starting a turn is an interactive approval, like the configuration writes
  // beside it. `callHostConfigCommand` checks the handshake but attaches no
  // lease, and the host refuses an interactive command that arrives without
  // one, so this is the only call shape that can actually start a run.
  const result = await callApprovedHostConfigCommand<{
    started: boolean
    runId?: string
    agentId?: string
    refusal?: RunAdmissionRefusal
  }>(REMOTE_RUN_COMMANDS.run, {
    runId: input.runId,
    chatSessionId: input.chatSessionId,
    prompt: input.prompt,
    stamp: { ...input.stamp },
    // Every optional axis is omitted rather than sent as null. The request
    // schema is `additionalProperties: false` and the host reads a missing key
    // as "inherit", so an explicit null would be both a 422 and a lie.
    ...(input.model ? { model: input.model } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
    ...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
    ...(input.externalSessionId ? { externalSessionId: input.externalSessionId } : {}),
    // The one axis where `null` is sent: it is the explicit "native models"
    // instruction, which the Host must not confuse with "inherit".
    ...(input.cogniaModel !== undefined ? { cogniaModel: copyBinding(input.cogniaModel) } : {}),
    ...(input.attachments?.length
      ? {
          attachments: input.attachments.map(({ ref, name, mediaType }) => ({
            ref,
            name,
            mediaType,
          })),
        }
      : {}),
  })

  if (result.started && result.runId) {
    return { started: true, runId: result.runId, agentId: result.agentId ?? "" }
  }
  return {
    started: false,
    refusal: result.refusal ?? { kind: "config", reason: "unknown-config" },
  }
}

/**
 * Ask the host to stop a run.
 *
 * `true` means this call ended it — a terminal frame is on its way *because of
 * it*. `false` means the host had nothing to stop, which is the ordinary answer
 * when the turn finished a moment earlier.
 */
export async function cancelRemoteExternalTurn(runId: string): Promise<boolean> {
  const result = await callHostConfigCommand<{ cancelled: boolean }>(REMOTE_RUN_COMMANDS.cancel, {
    runId,
  })
  return result.cancelled === true
}

export type RemoteDecisionOutcome =
  { resolved: true } | { resolved: false; reason: "unknown" | "wrong-device" }

/** Answer a permission the running agent is blocked on. */
export async function resolveRemotePermission(
  decisionId: string,
  decision: ApprovalDecision
): Promise<RemoteDecisionOutcome> {
  return resolve({ decisionId, decision })
}

/** Answer an elicitation. The host stamps the request id, so it is not sent. */
export async function resolveRemoteElicitation(
  decisionId: string,
  response: AcpElicitationResponse
): Promise<RemoteDecisionOutcome> {
  return resolve({ decisionId, elicitation: response })
}

async function resolve(payload: Record<string, unknown>): Promise<RemoteDecisionOutcome> {
  const result = await callHostConfigCommand<{ resolved: boolean; reason?: string }>(
    REMOTE_RUN_COMMANDS.resolve,
    payload
  )
  if (result.resolved) return { resolved: true }
  return {
    resolved: false,
    reason: result.reason === "wrong-device" ? "wrong-device" : "unknown",
  }
}

export type RemoteSessionOperationsClient = Pick<
  ExternalAgentManager,
  | "getSessionOperationCapabilities"
  | "getSessionRuntimeState"
  | "refreshSessionCommands"
  | "executeSessionCommand"
  | "enqueueSessionInput"
  | "clearSessionInputQueue"
  | "setSessionQueuePolicy"
  | "setSessionRuntimeControls"
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
>

export async function callRemoteSessionOperation<T>(
  target: RemoteSessionTarget,
  action: RemoteSessionOperation,
  requestId = crypto.randomUUID()
): Promise<T> {
  const reads = [
    "capabilities",
    "snapshot",
    "commands",
    "runtimeState",
    "entries",
    "tree",
    "watch",
    "unwatch",
  ]
  const read = reads.includes(action.operation)
  const result = await (read ? callHostConfigCommand : callApprovedHostConfigCommand)<{ value: T }>(
    read ? HOST_CONFIG_COMMANDS.sessionQuery : HOST_CONFIG_COMMANDS.sessionMutate,
    { ...target, stamp: { ...target.stamp }, requestId, action }
  )
  return result.value
}

/** Subscribe before mutation; renew its admission while this surface owns it. */
export async function watchRemoteSession(
  target: RemoteSessionTarget,
  handlers: RemoteRunSubscription,
  purpose: "transcript" | "presentation" | "shell" = "transcript"
) {
  const identity = getActiveRemoteTransport()
  const watchId = crypto.randomUUID()
  let closed = false
  const assertTarget = () => {
    if (getActiveRemoteTransport() !== identity)
      throw new Error("External session belongs to a different Host")
  }
  const unsubscribe = subscribeRemoteExternalRun(watchId, handlers)
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    await whenRemoteRunChannelSubscribed()
    assertTarget()
    const initial = await callRemoteSessionOperation<{
      session: import("@/types/agent/external-agent").ExternalAgentSession
    }>(target, { operation: "watch", watchId, purpose }, watchId)
    timer = setInterval(() => {
      if (closed) return
      try {
        assertTarget()
      } catch {
        handlers.onTerminal("failed", "External session belongs to a different Host")
        void close()
        return
      }
      void callRemoteSessionOperation(target, { operation: "watch", watchId, purpose }).catch(
        (error) => {
          handlers.onTerminal("failed", String(error))
          void close()
        }
      )
    }, 60_000)
    ;(timer as { unref?: () => void }).unref?.()
    return { watchId, session: initial.session, close }
  } catch (error) {
    unsubscribe()
    throw error
  }
  async function close() {
    if (closed) return
    closed = true
    if (timer) clearInterval(timer)
    unsubscribe()
    if (getActiveRemoteTransport() === identity)
      await callRemoteSessionOperation(target, { operation: "unwatch", watchId }).catch(
        () => undefined
      )
  }
}

/** The same session API consumed by the local operations component. */
export function createRemoteSessionOperationsClient(
  target: RemoteSessionTarget
): RemoteSessionOperationsClient {
  const identity = getActiveRemoteTransport()
  const call = <T>(agentId: string, sessionId: string, action: RemoteSessionOperation) => {
    if (
      getActiveRemoteTransport() !== identity ||
      agentId !== target.stamp.configId ||
      sessionId !== target.externalSessionId
    )
      return Promise.reject(new Error("External session target changed"))
    return callRemoteSessionOperation<T>(target, action)
  }
  return {
    getSessionOperationCapabilities: (a, s) => call(a, s, { operation: "capabilities" }),
    getSessionRuntimeState: (a, s) => call(a, s, { operation: "runtimeState" }),
    refreshSessionCommands: (a, s) => call(a, s, { operation: "commands" }),
    executeSessionCommand: (a, s, command) =>
      call(a, s, { operation: "commandExecution", command }),
    enqueueSessionInput: async (a, s, input, mode) => {
      const images = input.images?.map((image) => {
        const mimeType = image.mimeType
        if (
          mimeType !== "image/png" &&
          mimeType !== "image/jpeg" &&
          mimeType !== "image/webp" &&
          mimeType !== "image/gif"
        )
          throw new Error("Unsupported image MIME type")
        return { data: image.data, mimeType } as const
      })
      return call(a, s, { operation: "inputQueue", input: { text: input.text, images }, mode })
    },
    clearSessionInputQueue: (a, s) => call(a, s, { operation: "clearQueue" }),
    setSessionQueuePolicy: (a, s, policy) => call(a, s, { operation: "queuePolicy", policy }),
    setSessionRuntimeControls: (a, s, controls) =>
      call(a, s, { operation: "runtimeControls", controls }),
    abortSessionRetry: (a, s) => call(a, s, { operation: "abortRetry" }),
    getSessionEntries: (a, s) => call(a, s, { operation: "entries" }),
    getSessionTree: (a, s) => call(a, s, { operation: "tree" }),
    forkSession: (a, s, options) =>
      call(a, s, {
        operation: "fork",
        forkAt: options?.forkAt,
        forkAtEntryId: options?.forkAtEntryId,
      }),
    cloneSession: (a, s) => call(a, s, { operation: "clone" }),
    renameSession: (a, s, name) => call(a, s, { operation: "rename", name }),
    archiveSession: (a, s) => call(a, s, { operation: "archive" }),
    unarchiveSession: (a, s) => call(a, s, { operation: "unarchive" }),
    exportSessionHtml: (a, s) => call(a, s, { operation: "exportHtml" }),
    abortSessionShell: (a, s) => call(a, s, { operation: "abortShell" }),
    cancel: (a, s) => call(a, s, { operation: "cancel" }),
    steerSession: (a, s, text) =>
      s
        ? call(a, s, { operation: "steer", text })
        : Promise.reject(new Error("A native session id is required for steering")),
    executeSessionShell: async (a, s, command, options) => {
      if (
        getActiveRemoteTransport() !== identity ||
        a !== target.stamp.configId ||
        s !== target.externalSessionId
      )
        throw new Error("External session target changed")
      const requestId = crypto.randomUUID()
      let resolveResult!: (
        value: import("@cognia/agent-contracts/session-operations").ExternalAgentSessionShellResult
      ) => void
      let rejectResult!: (error: Error) => void
      const result = new Promise<
        import("@cognia/agent-contracts/session-operations").ExternalAgentSessionShellResult
      >((resolve, reject) => {
        resolveResult = resolve
        rejectResult = reject
      })
      void result.catch(() => undefined)
      const watcher = await watchRemoteSession(
        target,
        {
          onEvent: (event, frame) => {
            if (event.type !== "permission_request") return
            void options
              .onPermissionRequest(event.request)
              .then((response) =>
                resolveRemotePermission(
                  `${frame.runId}:${event.request.requestId ?? event.request.id}`,
                  response.granted ? (response.rememberChoice ? "allow_always" : "allow") : "deny"
                )
              )
              .catch(() =>
                resolveRemotePermission(
                  `${frame.runId}:${event.request.requestId ?? event.request.id}`,
                  "deny"
                )
              )
          },
          onOperationResult: (reply) => {
            if (reply.requestId !== requestId) return
            if (reply.error) rejectResult(new Error(reply.error))
            else
              resolveResult(
                reply.value as import("@cognia/agent-contracts/session-operations").ExternalAgentSessionShellResult
              )
          },
          onTerminal: (_terminal, error) =>
            rejectResult(new Error(error ?? "Remote session closed")),
          onGap: () => rejectResult(new Error("Remote shell result stream has a gap")),
        },
        "shell"
      )
      try {
        await callRemoteSessionOperation(
          target,
          {
            operation: "shell",
            command,
            excludeFromContext: options.excludeFromContext,
            watchId: watcher.watchId,
          },
          requestId
        )
        return await result
      } finally {
        await watcher.close()
      }
    },
  }
}
