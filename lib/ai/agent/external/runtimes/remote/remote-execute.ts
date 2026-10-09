/**
 * Run a host-owned external agent from the Composer, with the same contract as
 * running a local one.
 *
 * The chat controller's external branch is written against one call —
 * `executeOnExternalAgent(prompt, { onEvent })` returning an
 * `ExternalAgentResult` — and everything downstream of it (the ADR-0127
 * coalescer, `applyExternalAgentEventToParts`, the approval and elicitation
 * routing, the failure and fallback paths) hangs off that shape. So this
 * module presents exactly that shape over the remote plane instead of adding a
 * second branch. A remote turn is not a different product, and the branch that
 * renders it should not know which side of the wire the agent is on.
 *
 * The two things it must do that the local path gets for free:
 *
 *   - **Subscribe before starting.** The host begins streaming the moment it
 *     accepts, so a subscription opened after the RPC returns would miss the
 *     opening frames.
 *   - **Assemble `finalResponse`.** The local manager accumulates it while it
 *     drives the adapter; here the only evidence is the event stream, so the
 *     text deltas are collected as they pass through.
 */

import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type {
  AcpMcpServerConfig,
  ExternalAgentCogniaModelBinding,
  ExternalAgentEvent,
  ExternalAgentImageContent,
  ExternalAgentResult,
} from "@/types/agent/external-agent"
import type { ExternalAgentConfigStamp } from "@/types/agent/external-agent-config-store"

import {
  cancelRemoteExternalTurn,
  stageRemoteRunAttachments,
  startRemoteExternalTurn,
  subscribeRemoteExternalRun,
  whenRemoteRunChannelSubscribed,
  type RemoteRunAttachment,
} from "./remote-run-client"
import { remoteDecisionId } from "./remote-run-service"
import {
  HostCogniaModelUpdateRequiredError,
  hostSupportsAttachmentTurns,
  hostSupportsCogniaModelTurns,
} from "./remote-host-configs"
import { recordReportedAgentModelSurface } from "../../capability/model-surface-cache"
import { hostConfigCatalogMountIsLocal } from "../../config/host-config-mount"
import {
  resolveExternalAgentModels,
  resolveExternalAgentThinking,
  seededModelSurface,
} from "../../session/session-models"

export interface RemoteExecuteOptions {
  systemPrompt?: string
  allowedTools?: string[]
  /** Caller-local MCP servers require a reverse tool transport the paired host does not expose. */
  mcpServers?: AcpMcpServerConfig[]
  /**
   * Run on a Cognia provider/model through the Host's gateway, using the
   * Host's credentials. Omitted inherits the Host configuration; `null`
   * explicitly selects the agent's native models; a binding selects Cognia.
   */
  cogniaModel?: ExternalAgentCogniaModelBinding | null
  /** Which host configuration, at which revision and readiness generation. */
  stamp: ExternalAgentConfigStamp
  /** The chat session the frames are addressed to. */
  chatSessionId: string
  /** Resume a session this chat already established on the host. */
  externalSessionId?: string
  /** The model this conversation picked, replayed onto the host's session. */
  model?: string
  /** The composer's thinking level, in the app's vocabulary. */
  reasoningEffort?: string
  onEvent?: (event: ExternalAgentEvent) => void
  /**
   * A frame arrived out of order. Surfaced so the caller can say the transcript
   * is incomplete rather than render a hole as if nothing were missing.
   */
  onGap?: (expected: number, received: number) => void
  /**
   * The turn's images (`ExternalAgentManager.resolvePromptAttachments` runs on
   * the Host, against its own agent). Staged on the Host before the turn
   * starts.
   */
  attachments?: ExternalAgentImageContent[]
  /**
   * Some or all of `attachments` did not reach the agent: the Host's verdict
   * (`agent`, `model`), a ref that no longer resolved there or could not be
   * staged (`upload`), or a Host too old to take images (`host`). The turn
   * still runs, on its text.
   */
  onAttachmentsWithheld?: (withheld: RemoteAttachmentsWithheld) => void
  /** Injected in tests. */
  newRunId?: () => string
}

export interface RemoteAttachmentsWithheld {
  reason: "agent" | "model" | "upload" | "host"
  /** The model with no vision, for `model`. */
  model?: string
}

/** The chat-side id for a question this run is blocked on. */
export function remoteApprovalDecisionId(runId: string, responseRequestId: string): string {
  return remoteDecisionId(runId, responseRequestId)
}

/**
 * Text a message/content delta carries, in the two shapes adapters use.
 *
 * Deliberately narrow: anything that is not plainly a text delta is left to
 * `applyExternalAgentEventToParts`, which is the thing that actually renders
 * the turn. This accumulation exists only for the `finalResponse` fallback the
 * controller uses when an agent emitted no text track at all.
 */
function deltaText(event: ExternalAgentEvent): string {
  const candidate = event as { delta?: unknown; text?: unknown }
  if (typeof candidate.text === "string") return candidate.text
  if (typeof candidate.delta === "string") return candidate.delta
  const delta = candidate.delta as { text?: unknown } | undefined
  return typeof delta?.text === "string" ? delta.text : ""
}

const TEXT_EVENTS = new Set(["message_delta", "content_block_delta"])

/** Gateway task sessions (`gatewaySessionId` in `config/gateway-task`). */
const GATEWAY_SESSION_PREFIX = "cognia-gateway:"

/**
 * Keep the Host's report of the session's models for the composer's picker.
 *
 * The Host sends the session's options at the end of every turn (see
 * `reportSessionModels` in the run service). This client cannot write to that
 * session, so the surface is recorded as SEEDED: a pick is persisted on the
 * conversation and the Host applies it at the start of the next turn, which is
 * exactly the `model` this module already forwards.
 *
 * Skipped where the configuration is mounted in this same process (a desktop
 * that owns its host-config store): there the picker reads the live session
 * directly and can write to it, and a seeded copy would demote that.
 */
function recordHostModelReport(
  options: RemoteExecuteOptions,
  event: ExternalAgentEvent,
  externalSessionId: string
): void {
  if (event.type !== "config_options_update") return
  const sessionId = event.sessionId || externalSessionId
  if (!sessionId || hostConfigCatalogMountIsLocal()) return
  const configOptions = event.configOptions
  recordReportedAgentModelSurface(options.stamp.configId, options.chatSessionId, sessionId, {
    models: seededModelSurface(resolveExternalAgentModels({ configOptions })),
    thinking: resolveExternalAgentThinking({ configOptions }),
  })
}

/**
 * Run one turn on the host and resolve when it ends.
 *
 * Returns `null` only when the host refused to start — the same signal the
 * local path uses for "no external agent available for this request", so the
 * controller's existing refusal handling applies unchanged. A turn that started
 * and then failed resolves with `success: false` and the host's message.
 */
export async function executeOnRemoteHostAgent(
  prompt: string,
  options: RemoteExecuteOptions
): Promise<(ExternalAgentResult & { runId: string }) | null> {
  // A Host built before per-turn Cognia selection closes its request schema
  // against the field, and cannot resume a gateway task it was never asked to
  // run. Asking it to would be a 422 at best; say what fixes it instead.
  const needsCogniaTurns =
    !!options.cogniaModel || !!options.externalSessionId?.startsWith(GATEWAY_SESSION_PREFIX)
  const hostTakesCogniaModel = hostSupportsCogniaModelTurns()
  if (needsCogniaTurns && !hostTakesCogniaModel) throw new HostCogniaModelUpdateRequiredError()
  if (options.mcpServers?.length)
    throw new Error(
      "Paired-host agents cannot attach this device's MCP servers; configure tools on the target host"
    )
  if (
    !hasNoLeakingPiiDeep({
      prompt,
      systemPrompt: options.systemPrompt,
      allowedTools: options.allowedTools,
    })
  )
    throw new Error("Remote external agent input blocked by the outbound PII gate")
  const runId = options.newRunId?.() ?? `rer_${crypto.randomUUID()}`
  // Staged before the subscription opens: a slow upload must not leave a
  // subscribed run waiting on a turn that has not been asked for yet.
  let attachments: RemoteRunAttachment[] = []
  if (options.attachments?.length) {
    if (!hostSupportsAttachmentTurns()) {
      options.onAttachmentsWithheld?.({ reason: "host" })
    } else {
      try {
        attachments = await stageRemoteRunAttachments(runId, options.attachments)
      } catch {
        options.onAttachmentsWithheld?.({ reason: "upload" })
      }
    }
  }
  let text = ""
  let externalSessionId = options.externalSessionId ?? ""

  const startedAt = Date.now()
  let settle: (value: (ExternalAgentResult & { runId: string }) | null) => void = () => {}
  const finished = new Promise<(ExternalAgentResult & { runId: string }) | null>((resolve) => {
    settle = resolve
  })

  const stop = subscribeRemoteExternalRun(runId, {
    onEvent: (event) => {
      if (event.type === "session_start" && (event as { sessionId?: string }).sessionId) {
        externalSessionId = (event as { sessionId: string }).sessionId
      }
      if (TEXT_EVENTS.has(event.type)) text += deltaText(event)
      recordHostModelReport(options, event, externalSessionId)
      options.onEvent?.(event)
    },
    onGap: options.onGap,
    onAttachmentsWithheld: (withheld) =>
      options.onAttachmentsWithheld?.({
        reason: withheld.reason,
        ...(withheld.model ? { model: withheld.model } : {}),
      }),
    onTerminal: (terminal, error) => {
      settle({
        runId,
        success: terminal === "completed",
        sessionId: externalSessionId,
        finalResponse: text,
        // Empty rather than reconstructed: the host already rendered the turn
        // into parts through the event stream, and these three fields exist for
        // callers that consume a completed transcript. Rebuilding them from the
        // frames would be a second, divergent renderer.
        messages: [],
        steps: [],
        toolCalls: [],
        duration: Date.now() - startedAt,
        ...(terminal === "completed" ? {} : { error: error ?? terminal }),
      })
    },
  })

  try {
    // Subscribed is not the same as delivered: wait for the host to
    // acknowledge the topic before it has anything to stream on it.
    await whenRemoteRunChannelSubscribed()
    const started = await startRemoteExternalTurn({
      runId,
      chatSessionId: options.chatSessionId,
      stamp: options.stamp,
      prompt,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      systemPrompt: options.systemPrompt,
      allowedTools: options.allowedTools,
      externalSessionId: options.externalSessionId,
      // An explicit `null` ("native") is only sent to a Host that knows the
      // field. An older Host never took a per-turn selection at all: its own
      // configuration decides, exactly as it did before this axis existed.
      ...(options.cogniaModel !== undefined && hostTakesCogniaModel
        ? { cogniaModel: options.cogniaModel }
        : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    })
    if (!started.started) {
      stop()
      return null
    }
    return await finished
  } finally {
    stop()
  }
}

/**
 * Stop a remote turn.
 *
 * Best-effort and never throws: this runs on an interrupt path where the user
 * has already moved on, and the host's own disconnect handling ends an
 * abandoned run regardless.
 */
export async function interruptRemoteHostAgent(runId: string): Promise<void> {
  try {
    await cancelRemoteExternalTurn(runId)
  } catch {
    // See the docstring.
  }
}
