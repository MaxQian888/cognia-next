import { randomUUID } from "node:crypto"
import { awaitPending } from "../../shared/pending.ts"
import type { PendingEntry } from "../../shared/pending.ts"
/** PostToolUse rewrite runs before the tool result reaches the model. */
export function createOutputReviewer({
  pending,
  sessionId,
  emit,
  isStopped,
  remoteExecutionContext,
}: {
  pending: Map<string, PendingEntry<unknown>>
  sessionId: string
  emit(event: Record<string, unknown>): void
  isStopped(): boolean
  remoteExecutionContext?: unknown
}) {
  return async (
    toolName: string,
    toolUseId: string | undefined,
    current: unknown,
    isError: boolean
  ) => {
    if (isStopped()) return undefined
    const reviewId = randomUUID()
    const promise = awaitPending(pending, reviewId, {
      timeoutMs: 30_000,
      onTimeout: () => undefined,
    })
    emit({
      type: "tool_result_review",
      sessionId,
      reviewId,
      toolUseId: toolUseId ?? "",
      toolName: toolName ?? "",
      result: current,
      isError: isError === true,
      ...(remoteExecutionContext ? { remoteExecutionContext: remoteExecutionContext } : {}),
    })
    return promise
  }
}
