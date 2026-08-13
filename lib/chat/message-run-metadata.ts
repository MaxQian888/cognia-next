import type { UIMessage } from "ai"

export interface MessageRunMetadata {
  providerId?: string
  modelId?: string
  startedAt?: number
  completedAt?: number
  durationMs?: number
  finishReason?: string
}

export interface CompletedRunMetadataInput {
  providerId?: string
  modelId?: string
  startedAt?: number
  completedAt: number
  reportedDurationMs?: number
  finishReason?: string
}

/** Build an honest completion snapshot without consulting mutable session routing state. */
export function buildCompletedRunMetadata({
  providerId,
  modelId,
  startedAt,
  completedAt,
  reportedDurationMs,
  finishReason,
}: CompletedRunMetadataInput): MessageRunMetadata {
  return {
    providerId,
    modelId,
    startedAt,
    completedAt,
    durationMs:
      typeof reportedDurationMs === "number" && Number.isFinite(reportedDurationMs)
        ? reportedDurationMs
        : startedAt === undefined
          ? undefined
          : Math.max(0, completedAt - startedAt),
    finishReason,
  }
}

export function runMetadataOf(message: UIMessage): MessageRunMetadata | undefined {
  const run = (message.metadata as { run?: unknown } | undefined)?.run
  return run && typeof run === "object" ? (run as MessageRunMetadata) : undefined
}

export function attachRunMetadataToLastAssistant(
  messages: UIMessage[],
  run: MessageRunMetadata
): UIMessage[] {
  const entries = Object.entries(run).filter(([, value]) => value !== undefined)
  if (entries.length === 0) return messages
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== "assistant") continue
    const metadata = (message.metadata as Record<string, unknown> | undefined) ?? {}
    const existingRun = runMetadataOf(message)
    const next = messages.slice()
    next[index] = {
      ...message,
      metadata: { ...metadata, run: { ...(existingRun ?? {}), ...Object.fromEntries(entries) } },
    }
    return next
  }
  return messages
}
