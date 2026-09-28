import { errorMessage, type HookOutcome } from "../kernel/types.ts"
import { hasNoLeakingPiiDeep, redactText } from "@cognia/redact"
import { parseZeroExitOutput } from "../kernel/decision.ts"
import { HOOK_PII_BLOCK_REASON } from "../kernel/types.ts"
const DEFAULT_TIMEOUT_SECS = 5
const HARD_TIMEOUT_CAP_SECS = 30

/**
 * Run one `webhook` handler: HTTP POST the payload as the JSON body, parse the
 * 2xx response body through the same decision contract. Non-2xx / network
 * errors become soft-allow warnings.
 */
export async function runWebhookHandler(
  url: string,
  headers: Record<string, string> | undefined,
  configuredTimeout: number | undefined,
  payloadJson: string,
  signal?: AbortSignal
): Promise<HookOutcome> {
  // Outbound hooks never receive the original sensitive payload. Redact first;
  // then apply the deep gate to the redacted representation and fail closed if
  // a detector still finds data that the redactor could not remove.
  const redactedPayloadJson = redactText(payloadJson).redacted
  if (!hasNoLeakingPiiDeep(redactedPayloadJson)) {
    return { block: HOOK_PII_BLOCK_REASON }
  }
  const timeoutSecs = Math.min(
    typeof configuredTimeout === "number" && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_TIMEOUT_SECS,
    HARD_TIMEOUT_CAP_SECS
  )
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutSecs * 1000)
  const onOuterAbort = () => controller.abort()
  if (signal && typeof signal.addEventListener === "function") {
    signal.addEventListener("abort", onOuterAbort, { once: true })
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(headers ?? {}) },
      body: redactedPayloadJson,
      signal: controller.signal,
    })
    const body = await res.text()
    if (!res.ok) {
      return { warning: `hook webhook ${res.status}` }
    }
    return parseZeroExitOutput(body)
  } catch (e) {
    return {
      warning:
        controller.signal.aborted && !signal?.aborted
          ? "hook webhook timed out"
          : `hook webhook failed: ${errorMessage(e)}`,
    }
  } finally {
    clearTimeout(timer)
    if (signal && typeof signal.removeEventListener === "function") {
      signal.removeEventListener("abort", onOuterAbort)
    }
  }
}
