/** Shared continuation semantics; protocols keep their existing send/session machinery. */
import type { UIMessage } from "ai"
import type { CogniaDiagnostic } from "@cognia/diagnostics"
import type { AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"

export type ChatTurnOutcomeState = "running" | "completed" | "interrupted" | "failed"

export interface ChatTurnOutcome {
  state: ChatTurnOutcomeState
  revision: number
  retryable: boolean
}

export function lastUserMessage(messages: readonly UIMessage[]): UIMessage | undefined {
  return messages.findLast((message) => message.role === "user")
}

export function continuationMessageId(message: Pick<UIMessage, "id" | "metadata">): string {
  const remoteId = (
    message.metadata as { collaboration?: { remoteMessageId?: unknown } } | undefined
  )?.collaboration?.remoteMessageId
  return typeof remoteId === "string" ? remoteId : message.id
}

export function chatTurnOutcomeOf(metadata: unknown): ChatTurnOutcome | null {
  const value = (metadata as { chatTurnOutcome?: Partial<ChatTurnOutcome> } | null)?.chatTurnOutcome
  return value &&
    ["running", "completed", "interrupted", "failed"].includes(value.state ?? "") &&
    Number.isSafeInteger(value.revision) &&
    typeof value.retryable === "boolean"
    ? (value as ChatTurnOutcome)
    : null
}

export function isRecoverableChatFailure(
  diagnostic: CogniaDiagnostic | null | undefined,
  message?: string | null
): boolean {
  if (diagnostic) {
    if (diagnostic.code === "rateLimited" || diagnostic.code === "quotaExceeded") return false
    return diagnostic.retryable && diagnostic.actions.some((action) => action.kind === "retry")
  }
  return /disconnect|network|timed?\s*out|unexpected.*(?:exit|stop)|interrupt|abort/i.test(
    message ?? ""
  )
}

export function canContinueChat(input: {
  status: string
  messages: readonly UIMessage[]
  diagnostic?: CogniaDiagnostic | null
  errorMessage?: string | null
  queued?: boolean
}): boolean {
  if (input.queued || !["idle", "error"].includes(input.status)) return false
  const user = lastUserMessage(input.messages)
  if (!user) return false
  const outcome = chatTurnOutcomeOf(user.metadata)
  if (outcome?.state === "completed") return false
  if (input.status === "error") {
    return isRecoverableChatFailure(input.diagnostic, input.errorMessage)
  }
  // A persisted running turn in an idle, hydrated conversation lost its owner
  // across reload. A live/queued turn is excluded above and by the send gate.
  return (
    outcome?.state === "interrupted" ||
    outcome?.state === "running" ||
    (outcome?.state === "failed" && outcome.retryable)
  )
}

/** Persist only well-formed runtime identities; Host admission stamps remain mandatory. */
export function continuationRuntimeOf(metadata: unknown): AgentRuntimeRef | undefined {
  const value = (metadata as { continuationRuntime?: unknown } | null)?.continuationRuntime
  if (!value || typeof value !== "object") return undefined
  const ref = value as Record<string, unknown>
  if (ref.kind === "builtin") return { kind: "builtin" }
  if (ref.kind === "external" && typeof ref.agentId === "string" && ref.agentId) {
    return { kind: "external", agentId: ref.agentId }
  }
  if (
    ref.kind === "host" &&
    typeof ref.configId === "string" &&
    ref.configId &&
    typeof ref.revision === "string" &&
    Number.isSafeInteger(ref.lifecycleGeneration)
  ) {
    return value as AgentRuntimeRef
  }
  return undefined
}

/** Streaming mirrors can predate a terminal metadata write. Keep the newer stamp. */
export function mergeChatTurnMetadata(
  incoming: Record<string, unknown> | undefined,
  previous: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const before = chatTurnOutcomeOf(previous)
  const next = chatTurnOutcomeOf(incoming)
  const keep =
    before &&
    (!next ||
      before.revision > next.revision ||
      (before.revision === next.revision && next.state === "running" && before.state !== "running"))
  if (!keep && (!previous?.continuationRuntime || incoming?.continuationRuntime)) return incoming
  return {
    ...incoming,
    ...(previous?.continuationRuntime && !incoming?.continuationRuntime
      ? { continuationRuntime: previous.continuationRuntime }
      : {}),
    ...(keep ? { chatTurnOutcome: before } : {}),
  }
}

/** Narrow metadata allowed to travel with a shared continuation request/history. */
export function pickChatContinuationMetadata(
  metadata: unknown
): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  const value = metadata as Record<string, unknown>
  const runtime = continuationRuntimeOf(metadata)
  const outcome = chatTurnOutcomeOf(metadata)
  const anchor = typeof value.continuationOf === "string" && value.continuationOf
  if (!runtime && !outcome && !anchor) return undefined
  return {
    ...(runtime ? { continuationRuntime: runtime } : {}),
    ...(outcome ? { chatTurnOutcome: outcome } : {}),
    ...(anchor ? { continuationOf: anchor } : {}),
  }
}
