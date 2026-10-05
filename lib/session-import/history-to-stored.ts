// The one mapping from an integration's neutral transcript (ADR-0217,
// `@cognia/agent-contracts/history`) into the app's `StoredMessage` rows and
// picker summaries. Readers in integration packages never build chat rows;
// the part shapes stay owned by `./to-parts`, which this module calls.

import type { StoredMessage } from "@cognia/agent-config-types"
import type {
  HistoryMessage,
  HistoryPart,
  HistorySessionSummary,
} from "@cognia/agent-contracts/history"
import { buildMessage, filePart, reasoningPart, textPart, toolPart } from "./to-parts"
import { importedUsageMetadata } from "./usage"
import type { SessionSummary } from "./types"

type Part = StoredMessage["parts"][number]

/** One neutral part as the chat renderer's part. */
export function historyPartToStoredPart(part: HistoryPart): Part {
  switch (part.type) {
    case "text":
      return textPart(part.text)
    case "reasoning":
      return reasoningPart(part.text)
    case "file":
      return filePart(part)
    case "commentary":
      return {
        type: "data-commentary",
        data: {
          ...(part.messageId ? { messageId: part.messageId } : {}),
          text: part.text,
          state: "done",
          source: part.source,
        },
      } as unknown as Part
    case "tool": {
      const built = toolPart({
        name: part.name,
        toolCallId: part.toolCallId,
        input: part.input,
      }) as Part & Record<string, unknown>
      if (part.result?.ok === true) {
        built.state = "output-available"
        built.output = part.result.output
      } else if (part.result?.ok === false) {
        built.state = "output-error"
        built.errorText = part.result.errorText
      }
      if (part.status !== undefined) built.status = part.status
      return built
    }
  }
}

/**
 * A parsed transcript as `StoredMessage` rows under `sessionId`. Message ids
 * follow position, so re-importing the same file reproduces them.
 */
export function historyMessagesToStored(
  sessionId: string,
  messages: readonly HistoryMessage[],
  projectId?: string
): StoredMessage[] {
  return messages.map((message, index) => {
    const usage = message.usage
      ? importedUsageMetadata(message.usage, message.usageModel)
      : undefined
    const metadata = message.annotations || usage ? { ...message.annotations, ...usage } : undefined
    return buildMessage({
      sessionId,
      projectId,
      index,
      role: message.role,
      parts: message.parts.map(historyPartToStoredPart),
      createdAt: message.createdAt,
      ...(metadata ? { metadata } : {}),
    })
  })
}

/** A reader's per-file summary as a picker row for the file at `locator`. */
export function historySummaryToSessionSummary(
  summary: HistorySessionSummary,
  locator: string
): SessionSummary {
  return {
    ref: { sourceId: summary.sourceId, originalSessionId: summary.originalSessionId, locator },
    title: summary.title,
    sourceId: summary.sourceId,
    messageCount: summary.messageCount,
    updatedAt: summary.updatedAt,
    cwd: summary.cwd,
    sourceVersion: summary.sourceVersion,
    relationKind: summary.relationKind,
    ...(summary.lifecycleStatus ? { lifecycleStatus: summary.lifecycleStatus } : {}),
    ...(summary.parentNativeSessionId
      ? { parentNativeSessionId: summary.parentNativeSessionId }
      : {}),
  }
}
