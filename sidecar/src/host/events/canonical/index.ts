import {
  record,
  asString,
  asNumber,
  compact,
  type CanonicalEvent,
  type SdkMappingState,
} from "./common.ts"
export type { CanonicalEvent, SdkMappingState } from "./common.ts"
import { fromAssistant, fromUser, fromStreamEvent } from "./content.ts"
import { fromResult } from "./result.ts"
import { fromSystem } from "./system.ts"

/**
 * Fresh per-attempt state for {@link canonicalEventsFromSdkMessage}.
 *
 * `expectStructuredOutput` has to be supplied by the caller because the result
 * message cannot be asked: a turn that requested a schema and got nothing looks
 * exactly like a turn that never requested one. Only whoever set `outputFormat`
 * knows, and that is the send options.
 *
 * @param {{ expectStructuredOutput?: boolean }} [opts]
 */
export function createSdkMappingState(
  opts: { expectStructuredOutput?: boolean } = {}
): SdkMappingState {
  return {
    // Backward-compatible latch for content deltas that arrived without a
    // message_start/id. Scoped streams use `streamedMessageIds` below so one
    // streamed assistant round cannot mute every later round in the attempt.
    sawStreamEvents: false,
    activeStreamMessageId: undefined,
    streamedMessageIds: new Set<string>(),
    // Tool-use ids already surfaced as `tool-call`. Both rails re-send a
    // sealed `tool_use` block in every later assistant snapshot (the AI SDK
    // adapter emits one snapshot per input-streaming step, then one at seal,
    // then one per text delta that follows), so without this a single call
    // reached the persisted log and the CLI three to four times over.
    emittedToolCallIds: new Set<string>(),
    expectStructuredOutput: opts.expectStructuredOutput === true,
  }
}

/**
 * Map one raw `SDKMessage` to zero or more canonical agent events.
 *
 * @param {any} evt
 * @param {{ sawStreamEvents: boolean, activeStreamMessageId?: string, streamedMessageIds?: Set<string> }} state per-attempt, from {@link createSdkMappingState}
 * @returns {any[]}
 */
export function canonicalEventsFromSdkMessage(
  value: unknown,
  state: SdkMappingState = createSdkMappingState()
): CanonicalEvent[] {
  if (!value || typeof value !== "object") return []
  const evt = record(value)

  switch (evt.type) {
    case "assistant":
      return fromAssistant(evt, state)
    case "user":
      return fromUser(evt)
    case "stream_event":
      return fromStreamEvent(evt, state)
    case "result":
      return fromResult(evt, state)
    case "system":
      return fromSystem(evt)

    case "tool_progress":
      return [
        compact({
          kind: "tool-progress",
          toolCallId: String(evt.tool_use_id ?? ""),
          toolName: String(evt.tool_name ?? ""),
          elapsedMs: Math.round((asNumber(evt.elapsed_time_seconds) ?? 0) * 1000),
          parentToolCallId: asString(evt.parent_tool_use_id),
          taskId: asString(evt.task_id),
          heartbeat: evt.heartbeat === true ? true : undefined,
          subagentType: asString(evt.subagent_type),
        }),
      ]

    case "tool_use_summary":
      return [
        {
          kind: "tool-summary",
          summary: String(evt.summary ?? ""),
          toolCallIds: Array.isArray(evt.preceding_tool_use_ids)
            ? evt.preceding_tool_use_ids.map(String)
            : [],
        },
      ]

    case "auth_status":
      return [
        compact({
          kind: "auth",
          authenticating: evt.isAuthenticating === true,
          output:
            Array.isArray(evt.output) && evt.output.length ? evt.output.map(String) : undefined,
          error: asString(evt.error),
        }),
      ]

    case "rate_limit_event": {
      const info = record(evt.rate_limit_info)
      if (!info || typeof info !== "object") return []
      if (!["allowed", "allowed_warning", "rejected"].some((value) => value === info.status))
        return []
      return [
        compact({
          kind: "rate-limit",
          status: info.status,
          rateLimitType: asString(info.rateLimitType),
          resetsAt: asNumber(info.resetsAt),
          utilization: asNumber(info.utilization),
          overageStatus: ["allowed", "allowed_warning", "rejected"].some(
            (value) => value === info.overageStatus
          )
            ? info.overageStatus
            : undefined,
          overageResetsAt: asNumber(info.overageResetsAt),
          overageDisabledReason: asString(info.overageDisabledReason),
          isUsingOverage:
            typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : undefined,
          overageInUse: typeof info.overageInUse === "boolean" ? info.overageInUse : undefined,
          surpassedThreshold: asNumber(info.surpassedThreshold),
          errorCode: asString(info.errorCode),
          canUserPurchaseCredits:
            typeof info.canUserPurchaseCredits === "boolean"
              ? info.canUserPurchaseCredits
              : undefined,
          hasChargeableSavedPaymentMethod:
            typeof info.hasChargeableSavedPaymentMethod === "boolean"
              ? info.hasChargeableSavedPaymentMethod
              : undefined,
        }),
      ]
    }

    case "prompt_suggestion":
      return [{ kind: "prompt-suggestion", suggestion: String(evt.suggestion ?? "") }]

    case "conversation_reset":
      return [
        { kind: "conversation-reset", newConversationId: String(evt.new_conversation_id ?? "") },
      ]

    default:
      // A member this build has never seen. Preserved as a diagnostic rather
      // than dropped — `check:sdk-surface` is what turns it into a CI failure.
      return [{ kind: "diagnostic", runtime: "claude-agent-sdk", payload: evt }]
  }
}
