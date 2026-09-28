import { asString, compact, type CanonicalEvent, type SdkMappingState } from "./common.ts"
import { classifyStructuredOutcome } from "@cognia/agent-config-types/claude-agent-sdk-options"
import {
  failureCodeFromResult,
  isProviderFailureResult,
  providerFailureMessage,
} from "../../../runtimes/claude-agent-sdk/result-terminal.ts"

/**
 * Turn settlement: usage, then the structured-output verdict, then the outcome.
 *
 * The verdict is emitted BEFORE the outcome so a consumer that stops reading at
 * `lifecycle: ended` has already seen it, and because it can change the outcome:
 * a turn the SDK calls a success is a FAILURE for us when a schema was
 * requested and no `structured_output` came back. Reporting that as `ended`
 * hands the caller `undefined` from a turn it was told had worked.
 */
export function fromResult(evt: Record<string, unknown>, state: SdkMappingState): CanonicalEvent[] {
  const events: CanonicalEvent[] = []
  if (evt.usage && typeof evt.usage === "object") {
    events.push({ kind: "usage", usage: evt.usage })
  }

  const structured = classifyStructuredOutcome(
    {
      subtype: asString(evt.subtype),
      is_error: evt.is_error === true,
      structured_output: evt.structured_output,
    },
    state?.expectStructuredOutput === true
  )
  if (structured) {
    events.push(compact({ kind: "structured-output", ...structured }))
  }

  const sdkSucceeded = evt.subtype === "success" && evt.is_error !== true
  if (sdkSucceeded && structured?.status === "missing") {
    events.push({
      kind: "failure",
      code: "structured_output_missing",
      message: "the turn completed but returned no structured_output for the requested json_schema",
      // The model answered in prose once; asking again can land differently, so
      // unlike a budget ceiling this is worth another attempt.
      retryable: true,
    })
    return events
  }
  if (sdkSucceeded) {
    events.push({ kind: "lifecycle", phase: "ended" })
  } else {
    events.push(
      compact({
        kind: "failure",
        // NOT `String(evt.subtype)`: an upstream 404 arrives as
        // `subtype: "success"` with `is_error: true`, which published the
        // nonsense failure code `"success"`. See `failureCodeFromResult`.
        code: failureCodeFromResult(evt),
        // A provider failure gets the status-led message, so a mistyped base
        // URL reads as `HTTP 404: …` rather than as the SDK's model-shaped
        // prose. Caller-owned ceilings keep their existing wording.
        message: isProviderFailureResult(evt)
          ? providerFailureMessage(evt)
          : (asString(evt.result) ?? String(evt.subtype ?? "error")),
        // Budget and turn ceilings are the caller's policy, not a transient
        // fault — retrying the same request hits the same wall. Schema retries
        // are likewise already exhausted by the SDK itself.
        retryable: evt.subtype === "error_during_execution" ? true : undefined,
      })
    )
  }
  return events
}
